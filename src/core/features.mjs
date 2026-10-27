// @ts-check
// Features withheld from users until they are reworked. Read at call time so
// tests can opt in per file through the environment.
export const slangAvailable = () =>
  process.env.QQ_AGENTS_EXPERIMENTAL_SLANG === "1";
