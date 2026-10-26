import { createHash } from "node:crypto";
import { humanInput } from "./input-progress.mjs";
import { publicUrl } from "../apps/urls.mjs";
import { privateGithubSources } from "../github/policy.mjs";

const stable = (v) => JSON.stringify(sort(v));
function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  return v && typeof v === "object"
    ? Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      )
    : v;
}
export function publicRequestUrl(value) {
  const u = publicUrl(value);
  u.hash = "";
  return u.href;
}
export function sourceClass(runtime, ctx, id) {
  if (id.startsWith("github-private:")) return "private-repository";
  if (/^(operations|operations-result):/.test(id)) return "operations";
  if (id.startsWith("context:"))
    return id.startsWith("context:private:")
      ? "private-conversation"
      : id.startsWith("context:group:")
        ? "group-conversation"
        : "internal";
  const m = runtime.memory.bind(ctx.agentId);
  const row = m.db
    .prepare(
      "SELECT conversation,kind,payload FROM events WHERE agent_id=? AND id=?",
    )
    .get(ctx.agentId, id);
  if (row) {
    if (JSON.parse(row.payload).protectedRepositories?.length)
      return "private-repository";
    const app = JSON.parse(row.payload).app;
    if (app?.origin === "app-browser" && !app.source) return "public-platform";
    const source = app?.source?.conversation || row.conversation;
    return source.startsWith("private:")
      ? "private-conversation"
      : source.startsWith("group:")
        ? "group-conversation"
        : "internal";
  }
  const diary = m.db
    .prepare("SELECT metadata FROM diaries WHERE agent_id=? AND id=?")
    .get(ctx.agentId, id);
  if (diary) {
    if (JSON.parse(diary.metadata).protectedRepositories?.length)
      return "private-repository";
    return JSON.parse(diary.metadata).protectedOperations
      ? "operations"
      : "personal-diary";
  }
  // Deleted legacy records and frozen handoffs retain their protection.
  return "unknown-legacy";
}
export function sourceCounts(runtime, ctx) {
  const counts = {};
  for (const id of ctx.privateRead) {
    const type = sourceClass(runtime, ctx, id);
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}
function assertCredentials(runtime, ctx, request) {
  const raw = stable(request);
  let decoded = raw;
  for (let i = 0; i < 3; i++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  runtime.assertSafeOutput(ctx, decoded);
  // An arbitrary MCP server controls its own DNS and redirects. Do not delegate URL fetches
  // on the strength of a preflight lookup; use bridge web_fetch with pinned/hop checks.
  if (
    request.tool === "external_tool" &&
    /(?:https?|ftp|sftp|file|gopher|ws|wss|data):|\/\/|\\\\/i.test(decoded)
  )
    throw Error("EXTERNAL_URL_REQUIRES_WEB_FETCH");
  if (
    /"(?:authorization|cookie|password|passwd|api_key|apikey|access_token|secret)"\s*:/i.test(
      decoded,
    )
  )
    throw Error("SENSITIVE_OUTPUT_BLOCKED");
  const envs = runtime.config.connections.flatMap((c) => [
    c.tokenEnv,
    ...Object.values(c.process?.env || {}),
  ]);
  for (const b of runtime.config.backends)
    for (const s of b.toolServers || [])
      envs.push(...Object.values(s.env), ...Object.values(s.headers));
  for (const a of runtime.config.agents) {
    if (a.operations?.totpEnv) envs.push(a.operations.totpEnv);
    if (a.github?.tokenEnv) envs.push(a.github.tokenEnv);
  }
  for (const key of envs.filter(Boolean)) {
    const value = process.env[key];
    if (!value || value.length < 6) continue;
    if (
      [
        value,
        encodeURIComponent(value),
        Buffer.from(value).toString("base64"),
        Buffer.from(value).toString("hex"),
      ].some((s) => raw.includes(s) || decoded.includes(s))
    )
      throw Error("SENSITIVE_OUTPUT_BLOCKED");
  }
  for (const url of raw.match(/https?:\/\/[^\s"<>]+/g) || [])
    publicRequestUrl(url);
}
// Authority comes from a visible transport-authenticated human message, never a model flag.
export function requestedByHuman(runtime, ctx, request, eventId) {
  if (!eventId || !ctx.requestEvents?.has(eventId)) return false;
  const row = humanInput(runtime, ctx, eventId);
  if (!row) return false;
  const text = row.body.trim();
  const { tool, args } = request;
  if (tool === "web_fetch" || tool === "app_read" || tool === "app_comments") {
    const urls = text.match(/https?:\/\/[^\s<>"'，。！？、）]+/g) || [];
    return urls.some((url) => {
      try {
        return publicRequestUrl(url) === publicRequestUrl(args.url);
      } catch {
        return false;
      }
    });
  }
  const platforms = {
    B站: ["bilibili", "hot"],
    哔哩哔哩: ["bilibili", "hot"],
    知乎: ["zhihu", "recommend"],
    小红书: ["xiaohongshu", "recommend"],
    贴吧: ["tieba", "hot"],
    小黑盒: ["heybox", "recommend"],
  };
  if (tool === "app_search") {
    const natural = text.match(
      /^(?:请)?在(B站|哔哩哔哩|知乎|小红书|贴吧|小黑盒)搜索[「“"]([^」”"]+)[」”"][。！!]?$/,
    );
    return (
      text === `/search ${args.platform} ${args.query}` ||
      !!(
        natural &&
        platforms[natural[1]][0] === args.platform &&
        natural[2] === args.query
      )
    );
  }
  if (tool === "app_browse") {
    const natural = text.match(
      /^(?:请)?(?:帮我)?(?:测试|浏览|打开)(?:一下)?\s*(B站|哔哩哔哩|知乎|小红书|贴吧|小黑盒|所有平台)\s*(?:能不能浏览|是否能浏览|能否浏览)?[。？?！!]?$/,
    );
    const targets =
      natural?.[1] === "所有平台"
        ? Object.values(platforms)
        : natural
          ? [platforms[natural[1]]]
          : [];
    return (
      text ===
        `/browse ${args.platform} ${args.entry}${args.board ? " " + args.board : ""}` ||
      (!args.board &&
        targets.some(
          ([platform, entry]) =>
            platform === args.platform && entry === args.entry,
        ))
    );
  }
  if (tool === "app_boards") return text === `/boards ${args.platform}`;
  if (tool === "external_tool") {
    const prefix = `/mcp ${args.serverId} ${args.tool} `;
    if (!text.startsWith(prefix) || args.audioInput) return false;
    try {
      return (
        stable(JSON.parse(text.slice(prefix.length))) === stable(args.arguments)
      );
    } catch {
      return false;
    }
  }
  return false;
}
function autonomouslyAllowed(runtime, ctx, request) {
  const agent = runtime.agent(ctx.agentId);
  if (agent.network?.autonomous !== true) return false;
  if (request.tool.startsWith("github_")) return agent.github?.enabled === true;
  if (request.tool === "web_fetch") {
    publicRequestUrl(request.args.url);
    return true;
  }
  if (
    [
      "app_browse",
      "app_search",
      "app_boards",
      "app_read",
      "app_comments",
    ].includes(request.tool)
  )
    return (
      agent.apps.enabled && agent.apps.platforms.includes(request.args.platform)
    );
  if (request.tool !== "external_tool" || request.args.audioInput) return false;
  const backend = runtime.config.backends.find((b) => b.id === agent.backendId);
  return !!backend?.toolServers.some(
    (server) =>
      server.id === request.args.serverId &&
      server.allowedTools.includes(request.args.tool),
  );
}

export function authorizeExternal(
  runtime,
  ctx,
  request,
  { requestEventId, fixed = false, privateRepository } = {},
) {
  runtime.assertActive(ctx);
  assertCredentials(runtime, ctx, request);
  const githubSources = privateGithubSources(ctx, runtime);
  // Public-URL and autonomous grants never authorize exporting private source code.
  // Only a server-validated read back to the same allowlisted repository is exempt.
  const githubRestricted =
    githubSources.length > 0 &&
    !(
      request.tool.startsWith("github_") &&
      privateRepository &&
      githubSources.every((repo) => repo === privateRepository)
    );
  const requested = requestedByHuman(runtime, ctx, request, requestEventId);
  const configured =
    request.tool === "web_fetch" &&
    (runtime.agent(ctx.agentId).network?.publicUrls || []).some((url) => {
      try {
        return publicRequestUrl(url) === publicRequestUrl(request.args.url);
      } catch {
        return false;
      }
    });
  // Fixed reads have no model-controlled outbound text/URLs; only caller-owned provenance may set this flag.
  if (!githubRestricted && (fixed || requested || configured))
    return {
      requested,
      basis: fixed
        ? "fixed-public-read"
        : requested
          ? "human-input"
          : "configured-url",
    };
  const records = [...ctx.privateRead]
    .filter((id) => sourceClass(runtime, ctx, id) !== "public-platform")
    .sort();
  // This is a persistent administrator grant for ordinary queries/reads, not
  // a deletion of provenance or permission to disclose operations/media bytes.
  if (
    autonomouslyAllowed(runtime, ctx, request) &&
    !githubRestricted &&
    !records.some((id) => sourceClass(runtime, ctx, id) === "operations")
  )
    return { requested: false, basis: "autonomous-network-permission" };
  if (!records.length)
    return { requested: false, basis: "no-protected-source" };
  const requestId = createHash("sha256")
    .update(stable({ request, records }))
    .digest("hex");
  if (ctx.externalGrants?.has(requestId))
    return { requested: false, basis: "exact-request-grant" };
  ctx.disclosureRequest = {
    reason: "external-service",
    records,
    requestId,
    request,
  };
  throw Error("PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED");
}
export function grantExternal(ctx, ids, requestId) {
  const pending = ctx.disclosureRequest;
  if (
    !requestId ||
    pending?.requestId !== requestId ||
    stable([...ids].sort()) !== stable([...pending.records].sort())
  )
    throw Error("EXACT_EXTERNAL_REQUEST_GRANT_REQUIRED");
  (ctx.externalGrants ??= new Map()).set(requestId, true);
  return {
    granted: ids,
    requestId,
    conversation: ctx.conversation,
    scope: "exact-request-and-sources-this-turn",
  };
}
