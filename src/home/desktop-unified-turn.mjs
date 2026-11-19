import { recallBoundary } from "../core/recall-boundary.mjs";
import { beginDesktopContext } from "./desktop-context.mjs";
import { DESKTOP_CONVERSATION, readDecision } from "./desktop-decision.mjs";

function activityChoice(args) {
  if (
    ["wait", "rest"].includes(args.action) &&
    Object.keys(args).length === 2 &&
    Number.isSafeInteger(args.waitMinutes) &&
    args.waitMinutes > 0 &&
    Number.isSafeInteger(Date.now() + args.waitMinutes * 60_000)
  )
    return { action: args.action, waitMinutes: args.waitMinutes };
}

function publicAttachments(runtime, ctx, mediaId) {
  if (!mediaId) return [];
  const media = runtime.media.metadata(ctx.agentId, mediaId);
  if (
    media?.kind !== "garden-snapshot" ||
    media.mimeType !== "image/png" ||
    media.bytes > 2 * 1024 * 1024 ||
    !media.sources?.some(
      ({ conversation }) => conversation === DESKTOP_CONVERSATION,
    )
  )
    throw Error("DESKTOP_ATTACHMENT_UNAVAILABLE");
  recallBoundary(runtime, ctx, { publicOnly: true }).assert(media);
  return [
    {
      id: media.id,
      name: media.title + ".png",
      mimeType: media.mimeType,
      bytes: media.bytes,
      kind: "garden-snapshot",
    },
  ];
}

export async function runDesktopTurn(host, request, sourceSignal) {
  const { runtime, live } = host;
  const { actor } = request;
  const agent = runtime.agent(actor);
  const conversation = DESKTOP_CONVERSATION;
  const controller = new AbortController();
  const external = AbortSignal.any([
    sourceSignal,
    AbortSignal.timeout(agent.behavior.turnTimeoutMs),
  ]);
  const abort = () => controller.abort(external.reason);
  if (external.aborted) abort();
  else external.addEventListener("abort", abort, { once: true });

  const visit = live?.visits.get(actor);
  const current = () =>
    host.live === live &&
    live?.visits.get(actor) === visit &&
    request.isCurrent();
  let ctx;
  const check = () => {
    controller.signal.throwIfAborted();
    if (
      !current() ||
      !host.connected(ctx) ||
      runtime.blockers(agent, conversation, ctx).length
    )
      throw Error("DESKTOP_VISIT_UNAVAILABLE");
  };

  let lifecycleChoice;
  let exchange;
  let release;
  let failure;
  const key = actor + "|" + conversation;
  const done = Promise.withResolvers();
  try {
    check();
    release = host.visit(actor).beginDesktop(controller, conversation);
    ctx = runtime.makeContext(actor, conversation, {
      controller,
      assertCurrent: check,
      unified: true,
      kind: "activity",
      decide(args) {
        const choice = activityChoice(args) ?? readDecision("chat", args);
        if (!choice) throw Error("DESKTOP_DECISION_INVALID");
        if (choice.action === "say") {
          if (choice.text) runtime.assertSafeOutput(ctx, choice.text);
          recallBoundary(runtime, ctx, { publicOnly: true }).assert({
            evidence: [...ctx.privateRead],
          });
          return live.say(
            actor,
            choice.text ?? "",
            publicAttachments(runtime, ctx, choice.mediaId),
            ctx.turnId,
          );
        }
        lifecycleChoice = choice;
        return { status: "recorded" };
      },
    });
    ctx.done = done.promise;
    ctx.desktopBodyInputAt = request.startedAt;
    ctx.desktopRoleMailCurrent = current;
    runtime.running.set(key, ctx);
    const backend = runtime.backendConnections.adapter(agent);
    if (!backend.runDesktop) throw Error("DESKTOP_VISIT_UNAVAILABLE");
    const attachments = host.attachments?.project(
      request.messages,
      runtime.config,
      agent,
      visit,
    );
    ctx.desktopVideoIds = attachments?.videoIds;
    ctx.desktopRecentVideo = host.attachments?.recentVideo(
      runtime.config,
      agent,
      visit,
    );
    exchange = beginDesktopContext(
      runtime,
      ctx,
      agent,
      backend,
      attachments ? { ...request, messages: attachments.messages } : request,
      controller.signal,
    );
    await backend.runDesktop({
      ...exchange,
      inputImages: attachments?.images,
      binding: { runId: ctx.turnId },
      budget: null,
      signal: controller.signal,
      beforeInput: () => {
        check();
        if (ctx.backendInputEpoch !== ctx.inputEpoch)
          attachments?.assertCurrent(
            runtime.config,
            runtime.agent(actor),
            visit,
          );
      },
      assertCanStart: check,
      onRunStarted: async () => check(),
      registerInputConsumer: (consume) => {
        ctx.desktopConsumeInput = consume;
      },
      maxToolResultBytes: 65536,
      socialContextToken: ctx.token,
    });
    await ctx.desktopToolTail;
    return lifecycleChoice;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (ctx) runtime.capabilities.delete(ctx.token);
      if (exchange) await exchange.finish(failure);
    } finally {
      if (ctx && runtime.running.get(key) === ctx) runtime.running.delete(key);
      external.removeEventListener("abort", abort);
      release?.();
      done.resolve();
    }
  }
}
