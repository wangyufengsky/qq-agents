import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  frameworkSnapshot,
  gitVersion,
} from "../src/core/framework-knowledge.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const index = process.argv.indexOf("--commit");
const git = gitVersion(root);
const commit = index >= 0 ? process.argv[index + 1] : git?.commit;
if (
  !/^[a-f0-9]{40}$/.test(commit || "") ||
  (git && (git.modified || git.commit !== commit))
)
  throw Error("FRAMEWORK_BUILD_REQUIRES_CLEAN_COMMIT");
const { contentDigest } = frameworkSnapshot(root);
fs.writeFileSync(
  new URL("../framework-build.json", import.meta.url),
  JSON.stringify({ commit, contentDigest }, null, 2) + "\n",
);
console.log(JSON.stringify({ commit, contentDigest }));
