// Report actionable validation bounds without echoing input values, paths,
// stack traces, provider errors or credentials into either model backend.
export function safeToolFailure(error) {
  if (
    /^(ANIMATION_[A-Z_]+|INVALID_GIF|INVALID_ANIMATION_RANGE)$/.test(
      error?.message || "",
    )
  )
    return {
      code: error.message,
      hint: "Animation frames were not read. Do not describe motion or silently treat it as a still. For invalid ranges, omit animation options to get an overview and duration first. Missing decoder requires an administrator to install/configure FFmpeg. Other animated formats currently require a GIF source; processing limits or decode errors do not mean the source is static.",
    };
  if (error?.name === "ZodError" && Array.isArray(error.issues))
    return {
      code: "INVALID_TOOL_ARGUMENTS",
      issues: error.issues.slice(0, 8).map((issue) => ({
        field: (issue.path || [])
          .filter(
            (p) =>
              typeof p === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p),
          )
          .slice(0, 4)
          .join("."),
        code: [
          "too_big",
          "too_small",
          "invalid_type",
          "invalid_value",
          "unrecognized_keys",
        ].includes(issue.code)
          ? issue.code
          : "invalid_argument",
        ...(Number.isFinite(issue.minimum) ? { minimum: issue.minimum } : {}),
        ...(Number.isFinite(issue.maximum) ? { maximum: issue.maximum } : {}),
      })),
      hint: "Correct the named arguments within these bounds, or omit optional budgets and use pagination. The operation did not succeed. Do not infer unread content or claim successful delivery.",
    };
  const hints = {
    REPLY_BURST_LIMIT:
      "Consecutive replies are exhausted. Read genuinely new human input before replying again; rereads, peer messages and restarting a turn do not refill this budget.",
    PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED:
      "This exact outbound request lacks authority. Use a configured exact public URL or a fully read current human requestEventId with matching parameters; otherwise the console must approve this request. Do not copy remembered private text into a different call.",
    EXTERNAL_URL_REQUIRES_WEB_FETCH:
      "Arbitrary MCP URL fetching cannot enforce bridge DNS/redirect checks. Use web_fetch for a public URL; no external call was made.",
    APP_OUTSIDE_HOURS:
      "The configured browsing hours reject this action. A matching current human requestEventId bypasses autonomous-only hours; an administrator all-hours policy still applies.",
  };
  return {
    code: /^[A-Z][A-Z0-9_:-]{0,100}$/.test(error?.message || "")
      ? error.message
      : "TOOL_FAILED",
    hint:
      hints[error?.message] ||
      "The operation was rejected or not confirmed. Do not claim success; unknown delivery must not be retried with a new request ID.",
  };
}
