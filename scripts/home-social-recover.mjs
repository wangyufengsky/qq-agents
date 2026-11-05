// @ts-check
import { prepareSocialRecovery } from "../src/home/social-recovery.mjs";
import { knownErrorCodes } from "../src/core/error-codes.mjs";
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--data" ||
    args[2] !== "--retention-days"
  )
    throw Error("SOCIAL_RECOVERY_USAGE");
  console.log(
    JSON.stringify(
      prepareSocialRecovery(args[1], { retentionDays: Number(args[3]) }),
    ),
  );
} catch (error) {
  // Never expose native parser, filesystem, or SQLite messages at this boundary.
  const code =
    error instanceof Error && knownErrorCodes.has(error.message)
      ? error.message
      : "SOCIAL_RECOVERY_FAILED";
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
}
