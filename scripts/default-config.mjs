// @ts-check
import fs from "node:fs";
import { format } from "prettier";
import { defaultConfig } from "../src/core/default-config.mjs";
const file = new URL("../examples/config.example.json", import.meta.url);
const expected = await format(JSON.stringify(defaultConfig(), null, 2), {
  parser: "json",
});
if (process.argv.includes("--write")) fs.writeFileSync(file, expected);
else if (fs.readFileSync(file, "utf8") !== expected)
  throw Error("Default example drift: run npm run defaults:write");
console.log("Default configuration example matches runtime defaults.");
