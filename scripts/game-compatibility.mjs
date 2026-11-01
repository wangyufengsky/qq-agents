// @ts-check
import { checkGameCompatibility } from "../src/games/framework/compatibility.mjs";
try {
  if (process.argv.length !== 3) throw Error("GAME_DATABASE_ARGUMENT_REQUIRED");
  console.log(JSON.stringify(checkGameCompatibility(process.argv[2])));
} catch (error) {
  const code =
    error instanceof Error && /^GAME_[A-Z_]+$/.test(error.message)
      ? error.message
      : "GAME_COMPATIBILITY_CHECK_FAILED";
  console.error(JSON.stringify({ compatible: false, error: code }));
  process.exitCode = 1;
}
