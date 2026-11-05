// @ts-check
import { randomUUID } from "node:crypto";

/** Only exact routes with documented server-enforced caps belong here. */
const profiles = Object.freeze({
  "openai-gpt-4.1-mini": Object.freeze({
    origin: "https://api.openai.com",
    model: "gpt-4.1-mini-2025-04-14",
    inputUpperBound: 1047576,
    outputParameter: "max_completion_tokens",
    maxOutput: 32768,
    reasoningIncluded: true,
  }),
});

/** @param {string} id @param {string} endpoint @param {string} model */
export function socialProviderProfile(id, endpoint, model) {
  const profile = profiles[/** @type {keyof typeof profiles} */ (id)];
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw Error("SOCIAL_BACKEND_UNSUPPORTED");
  }
  if (
    !profile ||
    url.origin !== profile.origin ||
    model !== profile.model ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/v1/chat/completions"
  )
    throw Error("SOCIAL_BACKEND_UNSUPPORTED");
  return profile;
}

/** A failed/aborted request may have consumed the entire reservation.
 * @param {any} budget @param {any} binding @param {number} ordinal
 * @param {number} inputUpperBound @param {number} outputCap
 * @param {() => Promise<() => Promise<any>>} prepare */
export async function boundedInference(
  budget,
  binding,
  ordinal,
  inputUpperBound,
  outputCap,
  prepare,
) {
  const requestId = `${binding.runId}:${ordinal}`;
  const reservation = await budget.reserveInference({
    runId: binding.runId,
    requestId,
    inputUpperBound,
    outputCap,
  });
  // The store must uniquely claim a reservation before returning permission.
  if (!reservation?.reservationId || reservation.claimed !== true)
    throw Error("SOCIAL_INFERENCE_ALREADY_CLAIMED");
  let request;
  try {
    request = await prepare();
  } catch {
    await budget.settleInference({
      reservationId: reservation.reservationId,
      status: "not_started",
    });
    throw Error("SOCIAL_INFERENCE_NOT_STARTED");
  }
  let result;
  try {
    result = await request();
  } catch {
    await budget.settleInference({
      reservationId: reservation.reservationId,
      status: "unknown",
    });
    throw Error("SOCIAL_INFERENCE_UNKNOWN");
  }
  const u = result?.usage;
  const measured =
    Number.isSafeInteger(u?.prompt_tokens) &&
    u.prompt_tokens >= 0 &&
    Number.isSafeInteger(u?.completion_tokens) &&
    u.completion_tokens >= 0 &&
    u.prompt_tokens <= inputUpperBound &&
    u.completion_tokens <= outputCap;
  await budget.settleInference({
    reservationId: reservation.reservationId,
    status: measured ? "completed" : "unknown",
    ...(measured
      ? {
          usage: {
            inputTokens: u.prompt_tokens,
            outputTokens: u.completion_tokens,
          },
        }
      : {}),
  });
  if (!measured) throw Error("SOCIAL_USAGE_UNVERIFIED");
  return result;
}

export const newSocialRunId = () => randomUUID();
