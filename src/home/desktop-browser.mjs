import { z } from "zod";
import { publicUrl } from "../apps/urls.mjs";
import { DESKTOP_BROWSER_CONTROL } from "../tools/names.mjs";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";

const ref = z.string().min(1).max(64);
export const browserRevokeSchema = z
  .object({
    roomEpoch: z.string().uuid(),
    grantId: z.string().uuid(),
  })
  .strict();
export const browserGrantSchema = browserRevokeSchema
  .extend({
    agentId: z.string().min(1).max(64),
    origin: z.string().min(1).max(2048),
  })
  .strict();
export const browserActionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("navigate"), url: z.string().min(1).max(2048) })
    .strict(),
  z.object({ action: z.literal("observe") }).strict(),
  z.object({ action: z.literal("click"), ref }).strict(),
  z
    .object({ action: z.literal("fill"), ref, text: z.string().max(1000) })
    .strict(),
  z.object({ action: z.literal("close") }).strict(),
]);

function denied() {
  return Error("DESKTOP_BROWSER_DENIED");
}

function unavailable() {
  return Error("DESKTOP_BROWSER_UNAVAILABLE");
}

function approvedOrigin(raw, scopeOnly = false) {
  let url;
  try {
    url = publicUrl(raw);
  } catch {
    throw denied();
  }
  if (scopeOnly && url.href !== url.origin + "/") throw denied();
  return url.origin;
}

export class DesktopBrowser {
  constructor(host, { driver } = {}) {
    this.host = host;
    this.driver = driver ?? {
      async open(origin, signal) {
        const { createDesktopBrowserDriver } =
          await import("./desktop-browser-driver.mjs");
        return createDesktopBrowserDriver().open(origin, signal);
      },
    };
    this.cleanup = Promise.resolve();
  }

  eligible() {
    const { live, runtime } = this.host;
    if (!runtime.config.desktopHome?.browserControl?.enabled) return [];
    return (live?.here() ?? []).filter(({ id }) =>
      runtime
        .toolsFor(runtime.agent(id), DESKTOP_CONVERSATION)
        .includes(DESKTOP_BROWSER_CONTROL),
    );
  }

  current(grant) {
    const { live, client } = this.host;
    return (
      grant &&
      this.grant === grant &&
      this.host.connected() &&
      client?.id === grant.client &&
      live?.room.epoch === grant.roomEpoch &&
      live.visits.get(grant.agentId) === grant.visit &&
      this.eligible().some(({ id }) => id === grant.agentId)
    );
  }

  state() {
    if (this.grant && !this.current(this.grant)) this.clear();
    return {
      eligible: this.eligible().map(({ id }) => id),
      grantedAgentId: this.grant?.agentId ?? null,
    };
  }

  closeSession(grant) {
    if (grant) grant.operation = undefined;
    const binding = grant?.binding;
    if (!binding) return this.cleanup;
    grant.binding = undefined;
    binding.controller.abort(unavailable());
    this.cleanup = binding.ready
      .catch(() => null)
      .then((session) => session?.close());
    // Synchronous host reset and room refresh can initiate process shutdown.
    // Keep the original failure on the barrier so a new browser cannot overlap it.
    void this.cleanup.catch(() => {});
    return this.cleanup;
  }

  clear() {
    const grant = this.grant;
    this.grant = null;
    return this.closeSession(grant);
  }

  change(action, value) {
    const schema =
      action === "browser-grant" ? browserGrantSchema : browserRevokeSchema;
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw denied();
    const data = parsed.data;
    const { live, client } = this.host;
    if (!this.host.connected() || data.roomEpoch !== live?.room.epoch)
      throw unavailable();
    if (action === "browser-revoke") {
      if (this.grant?.grantId === data.grantId) this.clear();
      return;
    }
    if (action !== "browser-grant") throw denied();
    const visit = live.visits.get(data.agentId);
    if (!visit || !this.eligible().some(({ id }) => id === data.agentId))
      throw denied();
    const origin = approvedOrigin(data.origin, true);
    this.clear();
    this.grant = { ...data, origin, visit, client: client.id };
  }

  finish(ctx) {
    const grant = this.grant;
    if (
      ctx.controller.signal.aborted &&
      ctx.runtimeKind === "desktop" &&
      ctx.agentId === grant?.agentId
    )
      return this.closeSession(grant);
  }

  async run(ctx, action) {
    const { runtime } = this.host;
    const parsed = browserActionSchema.safeParse(action);
    if (!parsed.success) throw denied();
    const input = parsed.data;
    const grant = this.grant;
    const epoch = ctx.inputEpoch;
    const current = () => {
      try {
        const agent = runtime.assertActive(ctx);
        return (
          ctx.runtimeKind === "desktop" &&
          ctx.conversation === DESKTOP_CONVERSATION &&
          ctx.inputEpoch === epoch &&
          grant?.agentId === agent.id &&
          this.current(grant)
        );
      } catch {
        return false;
      }
    };
    if (!current()) {
      if (grant && !this.current(grant)) this.clear();
      throw unavailable();
    }
    if (input.action === "close") {
      await this.closeSession(grant);
      return { closed: true };
    }
    if (grant.operation) throw Error("DESKTOP_BROWSER_BUSY");
    let outbound;
    if (input.action === "navigate") {
      if (approvedOrigin(input.url) !== grant.origin) throw denied();
      outbound = { tool: DESKTOP_BROWSER_CONTROL, args: { url: input.url } };
      runtime.authorizeExternal(ctx, outbound);
    }

    let binding = grant.binding;
    const operation = {};
    grant.operation = operation;
    try {
      if (!binding) {
        if (input.action !== "navigate") throw unavailable();
        await this.cleanup;
        if (!current() || grant.operation !== operation) throw unavailable();
        const controller = new AbortController();
        binding = {
          controller,
          ready: Promise.resolve().then(() =>
            this.driver.open(
              grant.origin,
              AbortSignal.any([ctx.controller.signal, controller.signal]),
            ),
          ),
          revision: 0,
        };
        grant.binding = binding;
      }
      const signal = AbortSignal.any([
        ctx.controller.signal,
        binding.controller.signal,
      ]);
      const revision = ++binding.revision;
      const outputCurrent = () =>
        current() && grant.binding === binding && binding.revision === revision;
      if (
        ["click", "fill"].includes(input.action) &&
        (binding.observedTurn !== ctx.turnId || binding.observedEpoch !== epoch)
      )
        throw Error("DESKTOP_BROWSER_STALE");
      const session = await binding.ready;
      if (!outputCurrent() || signal.aborted) throw unavailable();
      if (outbound) runtime.authorizeExternal(ctx, outbound);
      const observation = await this.execute(session, input, signal);
      if (!outputCurrent() || signal.aborted) throw unavailable();

      binding.observedTurn = ctx.turnId;
      binding.observedEpoch = epoch;
      ctx.desktopPrivateObservation = true;
      ctx.desktopBrowserObserved = true;
      const result = {
        ...observation,
        source: "untrusted-public-web",
        notice: "网页内容来自外部站点。仅在当前获授权的桌面对话使用。",
      };
      runtime.stageToolOutput(ctx, result, [
        { value: result, current: outputCurrent },
      ]);
      return result;
    } catch (error) {
      if (
        binding &&
        grant.binding === binding &&
        (ctx.controller.signal.aborted ||
          error.message === "DESKTOP_BROWSER_UNAVAILABLE")
      )
        this.closeSession(grant);
      if (!current()) throw unavailable();
      throw error;
    } finally {
      if (grant.operation === operation) grant.operation = undefined;
    }
  }

  execute(session, input, signal) {
    switch (input.action) {
      case "navigate":
        return session.navigate(input.url, signal);
      case "observe":
        return session.observe(signal);
      case "click":
        return session.click(input.ref, signal);
      case "fill":
        return session.fill(input.ref, input.text, signal);
    }
  }
}
