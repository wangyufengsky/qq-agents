// Report actionable validation bounds without echoing input values, paths,
// stack traces, provider errors or credentials into either model backend.
export function safeToolFailure(error) {
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
  return {
    code: /^[A-Z][A-Z0-9_:-]{0,100}$/.test(error?.message || "")
      ? error.message
      : "TOOL_FAILED",
    hint: "The operation was rejected or not confirmed. Do not claim success; unknown delivery must not be retried with a new request ID.",
  };
}
