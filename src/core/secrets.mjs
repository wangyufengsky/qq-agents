// Credential-shaped substrings. A prefix must begin a token, so ordinary words
// such as "risk-assessment" or "task-scheduler" are not mistaken for keys.
const CREDENTIAL =
  /(?<![A-Za-z0-9_])(?:sk-|gh[pousr]_|github_pat_|Bearer\s+)[A-Za-z0-9_-]{16,}/;
export const containsCredential = (text) => CREDENTIAL.test(String(text));
