// @ts-check
import { prepareSocialRecovery } from "../src/home/social-recovery.mjs";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--data" || args[2] !== "--retention-days")
  throw Error(
    "Usage: --data OFFLINE_RESTORED_DATA --retention-days CURRENT_POLICY_DAYS",
  );
console.log(
  JSON.stringify(
    prepareSocialRecovery(args[1], { retentionDays: Number(args[3]) }),
  ),
);
