import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { attachmentName } from "./attachments.mjs";
import { qqFaceText } from "./qq-faces.mjs";
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
    messageId: raw.message_id == null ? null : String(raw.message_id),
    senderId: String(raw.user_id || raw.sender?.user_id || ""),
    senderName: raw.sender?.card || raw.sender?.nickname || "",
    ...(poke ? { targetId } : {}),
    kind: fileNotice
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
    const response = await this.fetch(
      this.config.httpUrl.replace(/\/$/, "") + "/" + action,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        redirect: "error",
      },
    );
    if (!response.ok) throw Error("ONEBOT_HTTP_ERROR");
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
      throw error;
    }
    return body.data;
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
