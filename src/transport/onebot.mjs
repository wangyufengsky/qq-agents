import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { attachmentName } from "./attachments.mjs";
import { qqFace, qqFaceText } from "./qq-faces.mjs";
import { downloadFileStream } from "./file-stream.mjs";

// A half-open TCP connection (NAT timeout, host sleep, a frozen gateway) never
// fires "close". Ping the gateway and treat a socket that has sent nothing,
// not even a pong, for this long as lost so connection recovery takes over.
export const HEARTBEAT_TIMEOUT_MS = 90000;

// The gateway can stay reachable after QQ itself logs out (kicked by another
// device, expired login, risk control). NapCat announces it with a bot_offline
// notice and later heartbeats carry status.online=false; only an explicit false
// counts, since some gateways omit the field.
export function reportsOffline(raw) {
  return (
    (raw.post_type === "notice" && raw.notice_type === "bot_offline") ||
    (raw.post_type === "meta_event" &&
      raw.meta_event_type === "heartbeat" &&
      raw.status?.online === false)
  );
}

export function normalizeEvent(raw, connection) {
  if (String(raw.self_id) !== connection.accountId)
    throw Error("QQ_ACCOUNT_MISMATCH");
  const isGroup = raw.message_type === "group" || raw.group_id !== undefined;
  const conversation = `${isGroup ? "group" : "private"}:${isGroup ? raw.group_id : raw.user_id}`;
  if (!/^(group|private):\d+$/.test(conversation)) return null;
  const recall =
    raw.notice_type === "group_recall" || raw.notice_type === "friend_recall";
  const fileNotice =
    ["group_upload", "offline_file"].includes(raw.notice_type) && raw.file;
  const reactionNotice = raw.notice_type === "group_msg_emoji_like";
  let reaction;
  if (reactionNotice) {
    if (
      raw.post_type !== "notice" ||
      !isGroup ||
      typeof raw.is_add !== "boolean" ||
      !/^\d+$/.test(String(raw.user_id)) ||
      !/^-?\d+$/.test(String(raw.message_id)) ||
      !Array.isArray(raw.likes) ||
      !raw.likes.length
    )
      return null;
    const likes = raw.likes.slice(0, 32).flatMap((/** @type {any} */ like) => {
      const face = qqFace({ id: like?.emoji_id });
      return face.id === null
        ? []
        : [
            {
              faceId: face.id,
              name: face.name,
              ...(Number.isSafeInteger(like.count) && like.count >= 0
                ? { count: like.count }
                : {}),
            },
          ];
    });
    if (!likes.length) return null;
    reaction = { messageId: String(raw.message_id), added: raw.is_add, likes };
  }
  const message = fileNotice ? [{ type: "file", data: raw.file }] : raw.message;
  if (
    raw.post_type !== "message" &&
    raw.post_type !== "message_sent" &&
    !recall &&
    raw.post_type !== "notice"
  )
    return null;
  // String CQ content is kept as text; no untrusted CQ string is executed on output.
  const segments = Array.isArray(message)
    ? message
    : message
      ? [{ type: "text", data: { text: String(message) } }]
      : [];
  let body = segments
    .map((s) =>
      s.type === "text"
        ? s.data?.text || ""
        : s.type === "file"
          ? `[文件: ${attachmentName(s.data).slice(0, 200) || "附件"}; 尚未下载或阅读]`
          : s.type === "at"
            ? `[提及 QQ:${s.data?.qq}]`
            : s.type === "reply"
              ? `[引用:${s.data?.id}]`
              : s.type === "face"
                ? qqFaceText(s.data)
                : `[${s.type}; 尚未识别内容]`,
    )
    .join("");
  const poke = raw.notice_type === "notify" && raw.sub_type === "poke";
  const targetId = poke && raw.target_id != null ? String(raw.target_id) : null;
  const join = raw.notice_type === "group_increase";
  if (reaction)
    body = `[${reaction.added ? "贴表情" : "取消贴表情"}] QQ:${raw.user_id} → 消息 ${reaction.messageId}：${reaction.likes.map((like) => like.name || `未知表情 ${like.faceId}`).join("、")}`;
  if (poke) body = `[拍一拍] QQ:${raw.user_id} → QQ:${raw.target_id}`;
  if (join) body = `[入群] QQ:${raw.user_id}`;
  if (raw.notice_type === "group_decrease") body = `[离群] QQ:${raw.user_id}`;
  if (raw.notice_type === "group_card")
    body = `[名片变更] QQ:${raw.user_id} ${String(raw.card_new || "").slice(0, 120)}`;
  const messageTime = new Date(Number(raw.time) * 1000);
  const timeKnown =
    Number(raw.time) > 0 && Number.isFinite(messageTime.getTime());
  return {
    conversation,
    // The notice references an existing message; it is not that message. Keep
    // its wire ID in reaction so different reactions do not deduplicate together.
    messageId: reaction
      ? null
      : raw.message_id == null
        ? null
        : String(raw.message_id),
    ...(reaction ? { reaction } : {}),
    senderId: String(raw.user_id || raw.sender?.user_id || ""),
    senderName: raw.sender?.card || raw.sender?.nickname || "",
    ...(poke ? { targetId } : {}),
    kind: reaction
      ? "notice.reaction"
      : fileNotice
        ? "notice.file"
        : recall
          ? "message.recalled"
          : poke
            ? "notice.poke"
            : join
              ? "notice.join"
              : raw.post_type === "notice"
                ? "notice"
                : "message.received",
    direction: raw.post_type === "message_sent" ? "out" : "in",
    status: recall ? "recalled" : "observed",
    body,
    segments,
    occurredAt: timeKnown
      ? messageTime.toISOString()
      : new Date().toISOString(),
    timeKnown,
    raw,
  };
}

// Account actions whose missing gateway support is reported as unsupported
// rather than as an opaque failure.
const actionUnsupportedChecks = new Set([
  "delete_msg",
  "set_msg_emoji_like",
  "set_qq_profile",
  "set_self_longnick",
  "set_qq_avatar",
  "get_cookies",
]);

const QZONE_ORIGIN = "https://user.qzone.qq.com";
const QZONE_MAX_BYTES = 256 * 1024;

/** QQ Zone's CSRF token: the page's own hash of the login key.
 * @param {string} key
 */
export function qzoneToken(key) {
  let hash = 5381;
  for (const char of key) hash += (hash << 5) + char.charCodeAt(0);
  return hash & 0x7fffffff;
}

/** The endpoints answer JSON, or JSON wrapped in a JSONP callback.
 * @param {string} text
 */
function qzoneBody(text) {
  const trimmed = text.trim();
  const wrapped = /^[\w.]+\(([\s\S]*)\)\s*;?$/.exec(trimmed);
  try {
    const body = JSON.parse(wrapped ? wrapped[1] : trimmed);
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** A status the endpoint actually stated; anything else is not a verdict.
 * @param {unknown} value
 */
function qzoneStatus(value) {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^-?\d+$/.test(value)
      ? Number(value)
      : null;
}

/** @param {any} body */
function qzoneRejection(body) {
  const error = Error("ONEBOT_REJECTED");
  // Only classify; the raw message is never kept.
  const detail = String(body?.message ?? body?.msg ?? "");
  error.reason =
    [-3000, -4001].includes(Number(body?.code)) ||
    [-3000, -4001].includes(Number(body?.subcode)) ||
    /登录|login/i.test(detail)
      ? "QZONE_LOGIN_REQUIRED"
      : "QZONE_REJECTED";
  return error;
}

export class OneBot extends EventEmitter {
  constructor(config, { fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    super();
    this.config = config;
    this.fetch = fetchImpl;
    this.WS = WebSocketImpl;
    this.connected = false;
    this.closed = true;
    this.epoch = 0;
    this.lastEventAt = null;
    this.lastFrameAt = null;
  }
  heartbeatTimeoutMs() {
    return this.config.recovery?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }
  headers() {
    const value = this.config.tokenEnv ? process.env[this.config.tokenEnv] : "";
    if (this.config.tokenEnv && !value) throw Error("ONEBOT_TOKEN_ENV_MISSING");
    return {
      "content-type": "application/json",
      ...(value ? { authorization: `Bearer ${value}` } : {}),
    };
  }
  async call(
    action,
    params = {},
    timeoutMs = 10000,
    { maxBytes = 2 * 1024 * 1024, signal } = {},
  ) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const headers = this.headers();
    let response;
    try {
      response = await this.fetch(
        this.config.httpUrl.replace(/\/$/, "") + "/" + action,
        {
          method: "POST",
          headers,
          body: JSON.stringify(params),
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          redirect: "error",
        },
      );
    } catch (cause) {
      // Timeouts and cancellations keep their own error names, which callers
      // already map. A bare "fetch failed" (gateway down, refused, DNS) would
      // otherwise leave the process as INTERNAL_ERROR instead of a retryable
      // gateway outage.
      if (deadline.aborted || signal?.aborted) throw cause;
      throw Error("ONEBOT_UNREACHABLE", { cause });
    }
    if (!response.ok) {
      if (actionUnsupportedChecks.has(action) && response.status === 404) {
        const error = Error("ONEBOT_REJECTED");
        error.reason = "ACTION_UNSUPPORTED";
        throw error;
      }
      throw Error("ONEBOT_HTTP_ERROR");
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw Error("ONEBOT_RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.status !== "ok" || body.retcode !== 0) {
      const error = Error("ONEBOT_REJECTED");
      // Never expose the gateway's raw message/stack: it can contain tokens,
      // identifiers and local paths. Preserve only recognized operator causes.
      const detail = String(body.message || body.wording || "");
      if (/已禁用PacketBackend/i.test(detail))
        error.reason = "PACKET_BACKEND_DISABLED";
      else if (/packetBackend(?:发包能力)?不可用/i.test(detail))
        error.reason = "PACKET_BACKEND_UNAVAILABLE";
      // NapCat stopped waiting for QQ to confirm (for example QQ dropped
      // offline mid-send); the message can still go out afterwards.
      else if (/Timeout: NTEvent/i.test(detail))
        error.reason = "GATEWAY_TIMEOUT";
      if (
        actionUnsupportedChecks.has(action) &&
        error.reason !== "GATEWAY_TIMEOUT" &&
        (body.retcode === 1404 ||
          body.retcode === 404 ||
          /unsupported|not supported|unknown (?:api|action)|不支持|接口不存在/i.test(
            detail,
          ))
      )
        error.reason = "ACTION_UNSUPPORTED";
      throw error;
    }
    return body.data;
  }
  async recall(messageId) {
    await this.call("delete_msg", { message_id: String(messageId) });
    return { confirmed: true };
  }
  async status() {
    const login = await this.call("get_login_info");
    if (String(login?.user_id) !== this.config.accountId)
      throw Error("QQ_ACCOUNT_MISMATCH");
    const status = await this.call("get_status");
    return {
      accountMatches: true,
      online: status?.online === true,
      good: status?.good !== false,
    };
  }
  downloadFile(fileId, options) {
    return downloadFileStream(this, fileId, options);
  }
  downloadImage(fileId, options) {
    // QQ can advertise the compressed message size while streaming the larger
    // original. Actual bytes, sequence and final receipt remain authoritative.
    return downloadFileStream(this, fileId, { ...options, sizeHintOnly: true });
  }
  async connect() {
    this.close();
    const epoch = ++this.epoch;
    this.closed = false;
    const s = await this.status();
    if (!s.online) throw Error("QQ_OFFLINE");
    if (this.closed || epoch !== this.epoch)
      throw Error("CONNECTION_CANCELLED");
    await new Promise((resolve, reject) => {
      const socket = new this.WS(this.config.wsUrl, {
        headers: this.headers(),
        maxPayload: 2 * 1024 * 1024,
        handshakeTimeout: 5000,
      });
      this.socket = socket;
      let settled = false,
        watchdog;
      const current = () =>
        !this.closed && epoch === this.epoch && this.socket === socket;
      const stopWatchdog = () => clearInterval(watchdog);
      // Take the socket down ourselves; its later "close" is no longer current
      // and must not report a second fault.
      const drop = (code) => {
        stopWatchdog();
        this.connected = false;
        this.socket = null;
        this.emit("fault", code);
        this.emit("status");
        if (typeof socket.terminate === "function") socket.terminate();
        else socket.close();
      };
      const startWatchdog = () => {
        const timeout = this.heartbeatTimeoutMs();
        if (!timeout) return;
        this.lastFrameAt = Date.now();
        watchdog = setInterval(
          () => {
            if (!current()) return stopWatchdog();
            if (Date.now() - this.lastFrameAt < timeout) {
              if (typeof socket.ping === "function")
                try {
                  socket.ping();
                } catch {
                  // A failing ping surfaces as an "error" or "close" event.
                }
              return;
            }
            drop("ONEBOT_HEARTBEAT_TIMEOUT");
          },
          Math.max(1000, Math.floor(timeout / 3)),
        );
        watchdog.unref?.();
      };
      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (this.cancelConnect === cancel) this.cancelConnect = null;
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => settle(Error("CONNECTION_CANCELLED"));
      this.cancelConnect = cancel;
      socket.once("open", () => {
        if (!current()) {
          cancel();
          return;
        }
        this.connected = true;
        startWatchdog();
        this.emit("status");
        settle();
      });
      socket.on("pong", () => {
        if (current()) this.lastFrameAt = Date.now();
      });
      socket.on("error", () => {
        if (!current()) return;
        const opened = this.connected;
        stopWatchdog();
        this.connected = false;
        settle(Error("ONEBOT_WS_ERROR"));
        if (opened) this.emit("fault", "ONEBOT_WS_ERROR");
        this.emit("status");
        socket.close();
      });
      socket.on("message", (data) => {
        if (!current()) return;
        this.lastFrameAt = Date.now();
        let raw;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          raw = null;
        }
        // One unreadable frame is dropped and reported; the receive channel stays up.
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          this.emit("fault", "INVALID_ONEBOT_EVENT");
          return;
        }
        // Another QQ account on this gateway is an identity failure: stop for good.
        if (String(raw.self_id) !== this.config.accountId) {
          this.emit("fault", "QQ_ACCOUNT_MISMATCH");
          this.close();
          return;
        }
        // An offline QQ cannot send or receive; hand it to connection recovery,
        // which only polls get_status and never logs QQ back in.
        if (reportsOffline(raw)) {
          drop("QQ_OFFLINE");
          return;
        }
        this.lastEventAt = Date.now();
        this.emit("event", raw);
      });
      socket.on("close", () => {
        // A socket replaced by close()/connect() must not mark the newer connection as down.
        if (!current()) return;
        stopWatchdog();
        settle(Error("CONNECTION_CANCELLED"));
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        if (wasConnected) this.emit("fault", "CONNECTION_LOST");
        this.emit("status");
      });
    });
  }
  async react(messageId, faceId) {
    const result = await this.call("set_msg_emoji_like", {
      message_id: String(messageId),
      emoji_id: String(faceId),
      set: true,
    });
    if (
      result === false ||
      result?.result === false ||
      (typeof result?.result === "number" && result.result !== 0)
    )
      throw Error("ONEBOT_REJECTED");
    return { confirmed: true };
  }
  async peerProfile({ userId, groupId }) {
    const info = await this.call(
      groupId ? "get_group_member_info" : "get_stranger_info",
      {
        user_id: userId,
        ...(groupId ? { group_id: groupId } : {}),
        no_cache: true,
      },
      10000,
      { maxBytes: 65536 },
    );
    // The uncached member lookup is the live membership check, not historical chat data.
    if (
      String(info?.user_id) !== userId ||
      (groupId && String(info?.group_id) !== groupId)
    )
      throw Error("PEER_PROFILE_IDENTITY_MISMATCH");
    const text = (value) =>
      typeof value === "string" ? value.slice(0, 200) : null;
    return {
      userId,
      nickname: text(info.nickname),
      signature: groupId
        ? null
        : text(info.long_nick ?? info.longNick ?? info.sign),
      ...(groupId
        ? {
            groupId,
            card: text(info.card),
            title: text(info.title),
            role: ["owner", "admin", "member"].includes(info.role)
              ? info.role
              : null,
          }
        : {}),
    };
  }
  async profile() {
    const info = await this.call(
      "get_stranger_info",
      { user_id: this.config.accountId, no_cache: true },
      10000,
      { maxBytes: 65536 },
    );
    if (String(info?.user_id) !== this.config.accountId)
      throw Error("QQ_ACCOUNT_MISMATCH");
    const text = (/** @type {unknown} */ value) =>
      typeof value === "string" ? value.slice(0, 200) : null;
    return {
      nickname: text(info.nickname),
      signature: text(info.long_nick ?? info.longNick ?? info.sign),
    };
  }
  // NapCat keeps the stored signature and gender when set_qq_profile omits them.
  async updateProfile({ nickname, signature, image }) {
    const [action, params] =
      nickname !== undefined
        ? ["set_qq_profile", { nickname }]
        : signature !== undefined
          ? ["set_self_longnick", { longNick: signature }]
          : ["set_qq_avatar", { file: "base64://" + image.toString("base64") }];
    const result = await this.call(action, params, 30000);
    if (
      result === false ||
      result?.result === false ||
      (typeof result?.result === "number" && result.result !== 0)
    )
      throw Error("ONEBOT_REJECTED");
    return { confirmed: true };
  }
  // QQ Zone has no OneBot action; NapCat only lends the web login cookies.
  // They and the derived token stay inside this call and are never logged,
  // stored or returned.
  async qzoneSession() {
    let data;
    try {
      data = await this.call(
        "get_cookies",
        { domain: "user.qzone.qq.com" },
        10000,
        { maxBytes: 16384 },
      );
    } catch (cause) {
      // Nothing was published yet, so this is a plain failure, never unknown.
      const error = Error("ONEBOT_REJECTED");
      error.reason =
        cause?.reason === "ACTION_UNSUPPORTED"
          ? "ACTION_UNSUPPORTED"
          : "QZONE_LOGIN_REQUIRED";
      throw error;
    }
    const jar = new Map();
    for (const part of String(data?.cookies ?? "").split(";")) {
      const at = part.indexOf("=");
      if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    const uin = String(jar.get("uin") ?? jar.get("p_uin") ?? "").replace(
      /^o0*/,
      "",
    );
    const key = jar.get("p_skey") || jar.get("skey");
    if ((uin && uin !== this.config.accountId) || !key) {
      // Still before publishing: a rejection, not an unknown result.
      const error = Error("ONEBOT_REJECTED");
      error.reason = key ? "QQ_ACCOUNT_MISMATCH" : "QZONE_LOGIN_REQUIRED";
      throw error;
    }
    return {
      token: qzoneToken(key),
      headers: {
        cookie: String(data.cookies),
        origin: QZONE_ORIGIN,
        referer: `${QZONE_ORIGIN}/${this.config.accountId}`,
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    };
  }
  async qzoneFetch(url, init) {
    const response = await this.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!response.ok) throw Error("QZONE_HTTP_ERROR");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > QZONE_MAX_BYTES) throw Error("QZONE_RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    return qzoneBody(Buffer.concat(chunks).toString("utf8"));
  }
  async qzonePost({ content }) {
    const session = await this.qzoneSession();
    const uin = this.config.accountId;
    // A transport error or unreadable reply leaves the post possibly public,
    // so it propagates as an unknown result rather than a rejection.
    const body = await this.qzoneFetch(
      `${QZONE_ORIGIN}/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${session.token}`,
      {
        method: "POST",
        headers: {
          ...session.headers,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          syn_tweet_verson: "1",
          paramstr: "1",
          who: "1",
          con: content,
          feedversion: "1",
          ver: "1",
          ugc_right: "1",
          to_sign: "0",
          hostuin: uin,
          code_version: "1",
          format: "json",
          qzreferrer: `${QZONE_ORIGIN}/${uin}`,
        }).toString(),
      },
    );
    const code = qzoneStatus(body?.code),
      subcode = qzoneStatus(body?.subcode);
    // Only an explicit non-zero status proves nothing was published; a reply
    // without one may follow a live post and must stay unknown.
    if (code == null || (body.subcode != null && subcode == null))
      throw Error("QZONE_RESPONSE_UNREADABLE");
    if (code !== 0 || (subcode != null && subcode !== 0))
      throw qzoneRejection(body);
    return { confirmed: typeof body.tid === "string" && body.tid !== "" };
  }
  async qzoneRecent({ limit }) {
    const session = await this.qzoneSession();
    const params = new URLSearchParams({
      uin: this.config.accountId,
      ftype: "0",
      sort: "0",
      pos: "0",
      num: String(limit),
      replynum: "0",
      g_tk: String(session.token),
      code_version: "1",
      format: "json",
      need_private_comment: "1",
    });
    const body = await this.qzoneFetch(
      `${QZONE_ORIGIN}/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?${params}`,
      { headers: session.headers },
    );
    if (body == null) throw Error("QZONE_RESPONSE_UNREADABLE");
    const code = qzoneStatus(body?.code);
    if (code == null) throw Error("QZONE_RESPONSE_UNREADABLE");
    if (code !== 0) throw qzoneRejection(body);
    return (Array.isArray(body.msglist) ? body.msglist : [])
      .slice(0, limit)
      .map((/** @type {any} */ post) => ({
        id: typeof post?.tid === "string" ? post.tid : null,
        text:
          typeof post?.content === "string" ? post.content.slice(0, 1000) : "",
        createdAt: Number.isFinite(post?.created_time)
          ? new Date(post.created_time * 1000).toISOString()
          : null,
        comments: Number.isFinite(post?.cmtnum) ? post.cmtnum : 0,
        images: Array.isArray(post?.pic) ? post.pic.length : 0,
      }));
  }
  async setTyping(conversation, { signal } = {}) {
    const target = /^private:(\d+)$/.exec(conversation)?.[1];
    if (!target || signal?.aborted) return;
    return this.call(
      "set_input_status",
      { user_id: target, event_type: 1 },
      1000,
      { signal, maxBytes: 4096 },
    );
  }
  async send(conversation, segments) {
    const [kind, target] = conversation.split(":");
    if (!["group", "private"].includes(kind) || !/^\d+$/.test(target))
      throw Error("INVALID_TARGET");
    const data = await this.call(
      kind === "group" ? "send_group_msg" : "send_private_msg",
      {
        [kind === "group" ? "group_id" : "user_id"]: Number(target),
        message: segments,
        auto_escape: true,
      },
      30000,
    );
    if (data?.message_id == null) throw Error("DELIVERY_UNCONFIRMED");
    return { messageId: String(data.message_id) };
  }
  async sendFile(conversation, buffer, name) {
    const [kind, target] = conversation.split(":");
    if (!["group", "private"].includes(kind) || !/^\d+$/.test(target))
      throw Error("INVALID_TARGET");
    const receipt = await this.call(
      kind === "group" ? "upload_group_file" : "upload_private_file",
      {
        [kind === "group" ? "group_id" : "user_id"]: target,
        file: "base64://" + buffer.toString("base64"),
        name,
        upload_file: true,
      },
      120000,
    );
    if (typeof receipt?.file_id !== "string" || !receipt.file_id)
      throw Error("DELIVERY_UNCONFIRMED");
    return { confirmed: true, fileId: receipt.file_id };
  }
  async sendForward(conversation, nodes) {
    const [kind, target] = conversation.split(":");
    if (!["group", "private"].includes(kind) || !/^\d+$/.test(target))
      throw Error("INVALID_TARGET");
    const data = await this.call(
      kind === "group" ? "send_group_forward_msg" : "send_private_forward_msg",
      {
        [kind === "group" ? "group_id" : "user_id"]: Number(target),
        messages: nodes,
      },
      30000,
    );
    if (data?.message_id == null) throw Error("DELIVERY_UNCONFIRMED");
    return { messageId: String(data.message_id) };
  }
  close() {
    this.closed = true;
    this.epoch++;
    this.cancelConnect?.();
    this.connected = false;
    this.socket?.close();
    this.socket = null;
  }
}
