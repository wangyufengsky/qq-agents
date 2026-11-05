// @ts-check

/** @param {any} lease */
function assertLease(lease) {
  if (
    !lease?.verifiedProvider ||
    !lease.reasoningIncluded ||
    !lease.retryBoundaryVerified ||
    typeof lease.runId !== "string" ||
    !lease.runId ||
    !Number.isSafeInteger(lease.fence) ||
    lease.fence < 0 ||
    !Number.isSafeInteger(lease.outputCap) ||
    lease.outputCap <= 0 ||
    !Number.isSafeInteger(lease.inputUpperBound) ||
    lease.inputUpperBound <= 0
  )
    throw Error("SOCIAL_BACKEND_UNSUPPORTED");
  return lease;
}

/** Install only in an isolated social preset. Transport/profile verification is
 * supplied by the host integration, never by prompt text or model arguments.
 * @param {any} ctx @param {any} control */
export function installDshSocialGuard(ctx, control) {
  const ordinals = new Map();
  ctx.on(
    "agent/request",
    async (/** @type {any} */ payload, /** @type {any} */ next) => {
      const config = await next();
      const lease = assertLease(
        await control.authorize(payload.agent.id, config),
      );
      return { ...config, maxTokens: lease.outputCap };
    },
  );
  ctx.on(
    "llm/stream",
    async function* (/** @type {any} */ request, /** @type {any} */ next) {
      const lease = assertLease(
        await control.authorize(request.sessionId, request),
      );
      if (request.maxTokens !== lease.outputCap)
        throw Error("SOCIAL_BACKEND_UNSUPPORTED");
      const ordinal = ordinals.get(lease.runId) || 0;
      ordinals.set(lease.runId, ordinal + 1);
      const reservation = await control.reserveInference({
        runId: lease.runId,
        requestId: `${lease.runId}:${ordinal}`,
        inputUpperBound: lease.inputUpperBound,
        outputCap: lease.outputCap,
      });
      if (!reservation?.reservationId || reservation.claimed !== true)
        throw Error("SOCIAL_INFERENCE_ALREADY_CLAIMED");
      let started = false;
      try {
        const current = assertLease(
          await control.authorize(request.sessionId, request),
        );
        if (
          current.runId !== lease.runId ||
          current.outputCap !== lease.outputCap ||
          current.inputUpperBound !== lease.inputUpperBound ||
          current.fence !== lease.fence
        )
          throw Error("SOCIAL_BACKEND_UNSUPPORTED");
        started = true;
        for await (const chunk of next()) yield chunk;
      } finally {
        // Stream chunk usage formats vary across host versions. Until a verified
        // projection exists, retain worst-case consumption even on normal EOF.
        await control.settleInference({
          reservationId: reservation.reservationId,
          status: started ? "unknown" : "not_started",
        });
      }
    },
  );
}
