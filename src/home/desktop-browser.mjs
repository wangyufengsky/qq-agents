import { z } from "zod";
import {
  DesktopControlGrants,
  localControlTargetId,
} from "./desktop-local-grant.mjs";
import { DesktopGrantLease } from "./desktop-grant-lease.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
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
    origin: z.string().min(1).max(2048).optional(),
    targetId: localControlTargetId.optional(),
  })
  .strict();
const browserActions = [
  z
    .object({ action: z.literal("navigate"), url: z.string().min(1).max(2048) })
    .strict(),
  z.object({ action: z.literal("observe") }).strict(),
  z.object({ action: z.literal("click"), ref }).strict(),
  z
    .object({ action: z.literal("fill"), ref, text: z.string().max(1000) })
    .strict(),
  z.object({ action: z.literal("close") }).strict(),
];
export const legacyBrowserActionSchema = z.discriminatedUnion(
  "action",
  browserActions,
);
export const browserActionSchema = z.discriminatedUnion("action", [
  ...browserActions.map((schema) =>
    schema.extend({ grantId: z.string().uuid().optional() }),
  ),
  z.strictObject({ action: z.literal("grants") }),
  z.strictObject({ action: z.literal("revoke"), grantId: z.string().uuid() }),
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
  constructor(host, { driver, managedDriver = driver } = {}) {
    this.host = host;
    this.unavailable = "DESKTOP_BROWSER_UNAVAILABLE";
    this.tool = DESKTOP_BROWSER_CONTROL;
    this.unified = new DesktopControlGrants(this);
    this.targets = new Map();
    this.db = host.runtime.memory?.db;
    this.db?.exec(`
      CREATE TABLE IF NOT EXISTS desktop_browser_targets (
        target_id TEXT PRIMARY KEY
      )
    `);
    // Only in-memory handles belong to a running browser. A target that existed
    // in a previous process must not be redirected to a newly opened browser.
    this.startedTargets = new Set(
      (
        this.db
          ?.prepare("SELECT target_id FROM desktop_browser_targets")
          .all() ?? []
      ).map(({ target_id }) => target_id),
    );
    this.lease = new DesktopGrantLease(host, "DESKTOP_BROWSER_UNAVAILABLE");
    this.driver = driver ?? {
      async open(origin, signal) {
        const { createDesktopBrowserDriver } =
          await import("./desktop-browser-driver.mjs");
        return createDesktopBrowserDriver().open(origin, signal);
      },
    };
    this.managedDriver = managedDriver ?? {
      async open(origin, signal) {
        const { createManagedDesktopBrowserDriver } =
          await import("./desktop-browser-managed.mjs");
        return createManagedDesktopBrowserDriver().open(origin, signal);
      },
    };
    this.cleanup = Promise.resolve();
    this.draining = false;
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
    if (grant?.unified) return this.unified.current(grant);
    const { live, client } = this.host;
    return (
      grant &&
      this.grant === grant &&
      this.lease.valid(grant) &&
      this.host.connected() &&
      client?.id === grant.client &&
      live?.room.epoch === grant.roomEpoch &&
      live.visits.get(grant.agentId) === grant.visit &&
      this.eligible().some(({ id }) => id === grant.agentId)
    );
  }

  state() {
    if (this.grant && !this.current(this.grant)) {
      this.lease.expired(this.grant);
      this.clear();
    }
    return {
      eligible: this.eligible().map(({ id }) => id),
      grantedAgentId: this.grant?.agentId ?? null,
      ...(this.unified.state().grants && { grants: this.grants() }),
      ...(this.grant?.expiresAt && { expiresAt: this.grant.expiresAt }),
    };
  }

  grants(agentId) {
    return this.unified.list(agentId).map((grant) => ({
      ...grant,
      targetStatus: !this.startedTargets.has(grant.targetId)
        ? "ready-to-open"
        : this.targets.get(grant.targetId)?.binding
          ? "open"
          : "unavailable",
    }));
  }

  started(targetId) {
    if (this.startedTargets.has(targetId)) return;
    this.db
      ?.prepare("INSERT INTO desktop_browser_targets VALUES (?)")
      .run(targetId);
    this.startedTargets.add(targetId);
  }

  target(grant) {
    if (!grant.unified) return grant;
    if (!this.targets.has(grant.targetId))
      this.targets.set(grant.targetId, {
        unified: true,
        origin: grant.origin,
        cleanup: Promise.resolve(),
      });
    return this.targets.get(grant.targetId);
  }

  revokeUnified(grantId, agentId) {
    const grant = this.unified.remove(grantId, agentId);
    if (!grant) return false;
    const target = this.targets.get(grant.targetId);
    if (
      target &&
      (target.operation?.grant === grant ||
        !this.unified
          .list()
          .some(({ targetId }) => targetId === grant.targetId))
    )
      void this.closeSession(target);
    this.host.notify?.();
    return true;
  }

  closeSession(grant) {
    const operation = grant?.operation;
    if (grant) grant.operation = undefined;
    const binding = grant?.binding;
    if (!binding) return grant?.unified ? grant.cleanup : this.cleanup;
    grant.binding = undefined;
    binding.controller.abort(unavailable());
    if (!grant.unified) this.draining = true;
    const cleanup = Promise.all([
      binding.ready.catch(() => null).then((session) => session?.close()),
      operation?.finished,
    ]).then(() => {
      if (!grant.unified) this.draining = false;
    });
    // Synchronous host reset and room refresh can initiate process shutdown.
    // Keep the original failure on the barrier so a new browser cannot overlap it.
    if (grant.unified) grant.cleanup = cleanup;
    else this.cleanup = cleanup;
    void cleanup.catch(() => {});
    return cleanup;
  }

  clear() {
    const grant = this.grant;
    this.lease.clear(grant);
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
      if (
        !this.revokeUnified(data.grantId) &&
        this.grant?.grantId === data.grantId
      )
        this.clear();
      return;
    }
    if (action !== "browser-grant") throw denied();
    if (data.targetId) {
      this.unified.change({ ...data, origin: undefined });
      return;
    }
    const visit = live.visits.get(data.agentId);
    if (!visit || !this.eligible().some(({ id }) => id === data.agentId))
      throw denied();
    const origin = approvedOrigin(data.origin, true);
    if (this.grant?.grantId === data.grantId && this.current(this.grant)) {
      if (this.grant.agentId !== data.agentId || this.grant.origin !== origin)
        throw unavailable();
      return;
    }
    const grant = { ...data, origin, visit, client: client.id };
    this.lease.attach(grant, () => {
      if (this.grant === grant) {
        this.lease.expired(grant);
        this.clear();
        this.host.notify();
      }
    });
    this.clear();
    this.grant = grant;
  }

  suspendUnified() {
    return Promise.allSettled(
      [...this.targets.values()].map((target) => this.closeSession(target)),
    );
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
    const unified =
      ctx.desktopUnified &&
      ctx.runtimeKind === "desktop" &&
      ctx.conversation === DESKTOP_CONVERSATION;
    const agent = unified ? runtime.assertActive(ctx) : undefined;
    if (input.action === "grants" || input.action === "revoke") {
      if (!unified) throw unavailable();
      if (input.action === "grants") return { grants: this.grants(agent.id) };
      return { revoked: this.revokeUnified(input.grantId, agent.id) };
    }
    if (!unified && input.grantId) throw unavailable();
    const grant = unified
      ? this.unified.get(input.grantId, agent.id)
      : this.grant;
    const epoch = ctx.inputEpoch;
    const visit = this.host.live?.visits.get(ctx.agentId);
    const client = this.host.client;
    const current = () => {
      try {
        const agent = runtime.assertActive(ctx);
        return (
          ctx.runtimeKind === "desktop" &&
          ctx.conversation === DESKTOP_CONVERSATION &&
          ctx.inputEpoch === epoch &&
          (!unified ||
            (this.host.client === client &&
              this.host.live?.visits.get(ctx.agentId) === visit)) &&
          grant?.agentId === agent.id &&
          (unified ||
            !ctx.desktopGrantBindings ||
            ctx.desktopGrantBindings.get(DESKTOP_BROWSER_CONTROL) === grant) &&
          this.current(grant)
        );
      } catch {
        return false;
      }
    };
    if (!current()) {
      if (!unified && grant && !this.current(grant)) this.clear();
      throw unavailable();
    }
    const target = this.target(grant);
    if (input.action === "close") {
      await this.closeSession(target);
      return { closed: true };
    }
    if (target.operation) throw Error("DESKTOP_BROWSER_BUSY");
    if (unified && this.startedTargets.has(grant.targetId) && !target.binding)
      throw unavailable();
    let outbound;
    if (input.action === "navigate") {
      const origin = approvedOrigin(input.url);
      if (!unified && origin !== grant.origin) throw denied();
      outbound = { tool: DESKTOP_BROWSER_CONTROL, args: { url: input.url } };
      runtime.authorizeExternal(ctx, outbound);
    }

    let binding = target.binding;
    let finishOperation;
    const operation = {
      grant,
      finished: new Promise((resolve) => {
        finishOperation = resolve;
      }),
    };
    target.operation = operation;
    try {
      if (!binding) {
        if (input.action !== "navigate") throw unavailable();
        await (unified ? target.cleanup : this.cleanup);
        if (!current() || target.operation !== operation) throw unavailable();
        const controller = new AbortController();
        binding = {
          controller,
          ready: Promise.resolve()
            .then(() =>
              (unified ? this.managedDriver : this.driver).open(
                grant.origin,
                AbortSignal.any([ctx.controller.signal, controller.signal]),
              ),
            )
            .then((session) => {
              if (unified) this.started(grant.targetId);
              return session;
            }),
          revision: 0,
        };
        target.binding = binding;
      }
      const signal = AbortSignal.any([
        ctx.controller.signal,
        binding.controller.signal,
      ]);
      const revision = ++binding.revision;
      const outputCurrent = () =>
        current() &&
        target.binding === binding &&
        binding.revision === revision;
      if (
        ["click", "fill"].includes(input.action) &&
        (binding.observedTurn !== ctx.turnId ||
          binding.observedEpoch !== epoch ||
          binding.observedAgentId !== ctx.agentId)
      )
        throw Error("DESKTOP_BROWSER_STALE");
      const session = await binding.ready;
      if (!outputCurrent() || signal.aborted) throw unavailable();
      if (outbound) runtime.authorizeExternal(ctx, outbound);
      let mutationOrigin;
      const authorize = unified
        ? (url, text, source) => {
            if (!outputCurrent() || signal.aborted) throw unavailable();
            if (input.action === "click" && text === undefined && !source)
              mutationOrigin = approvedOrigin(url);
            if (text !== undefined) this.assertManagedTextSource(ctx);
            runtime.authorizeExternal(ctx, {
              tool: DESKTOP_BROWSER_CONTROL,
              args: {
                url,
                action: input.action,
                ...(text !== undefined && { text }),
              },
            });
          }
        : undefined;
      if (unified && input.action === "click")
        authorize.post = (request) => {
          if (!outputCurrent() || signal.aborted || !mutationOrigin)
            throw unavailable();
          this.authorizeManagedMutation(ctx, mutationOrigin, request);
        };
      const observation = await this.execute(session, input, signal, authorize);
      if (!outputCurrent() || signal.aborted) throw unavailable();

      binding.observedTurn = ctx.turnId;
      binding.observedEpoch = epoch;
      binding.observedAgentId = ctx.agentId;
      ctx.desktopPrivateObservation = true;
      ctx.desktopBrowserObserved = true;
      ctx.recordDesktopRestrictedGrant?.(DESKTOP_BROWSER_CONTROL, grant, this);
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
        target.binding === binding &&
        ((!unified && ctx.controller.signal.aborted) ||
          (current() && error.message === "DESKTOP_BROWSER_UNAVAILABLE"))
      )
        this.closeSession(target);
      if (!current()) throw unavailable();
      throw error;
    } finally {
      finishOperation();
      if (target.operation === operation) target.operation = undefined;
    }
  }

  assertManagedTextSource(ctx) {
    const { runtime } = this.host;
    recallBoundary(runtime, ctx, { publicOnly: true }).assert({
      evidence: [...ctx.privateRead],
    });
    runtime.home.rooms.shareable(ctx);
  }

  authorizeManagedMutation(ctx, actionOrigin, request) {
    const { runtime } = this.host;
    const { url, method, body } = request;
    if (
      method !== "POST" ||
      typeof body !== "string" ||
      approvedOrigin(url) !== actionOrigin
    )
      throw denied();
    this.assertManagedTextSource(ctx);
    runtime.assertSafeOutput(ctx, body);
    runtime.authorizeExternal(ctx, {
      tool: DESKTOP_BROWSER_CONTROL,
      args: { url, method, body },
    });
  }

  execute(session, input, signal, authorize) {
    switch (input.action) {
      case "navigate":
        return session.navigate(input.url, signal, authorize);
      case "observe":
        return session.observe(signal, authorize);
      case "click":
        return session.click(input.ref, signal, authorize);
      case "fill":
        return session.fill(input.ref, input.text, signal, authorize);
    }
  }
}
