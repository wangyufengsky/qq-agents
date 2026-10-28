import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openNoFollow } from "../src/core/no-follow.mjs";
import { temp } from "./helpers.mjs";

// The flag path is what macOS/Linux use; flag 0 is the lstat + identity check
// Windows takes because it has no O_NOFOLLOW. Both must refuse a symlink.
for (const [label, options] of [
  ["O_NOFOLLOW", {}],
  ["lstat fallback", { noFollowFlag: 0 }],
]) {
  test(`openNoFollow (${label}) reads regular files and refuses symlinks`, (t) => {
    if (label === "O_NOFOLLOW" && !fs.constants.O_NOFOLLOW) return t.skip();
    const root = temp(t),
      outside = path.join(root, "outside"),
      link = path.join(root, "link");
    fs.writeFileSync(outside, "outside bytes");
    const fd = openNoFollow(outside, options);
    try {
      assert.equal(fs.readFileSync(fd, "utf8"), "outside bytes");
    } finally {
      fs.closeSync(fd);
    }
    fs.symlinkSync(outside, link);
    assert.throws(
      () => openNoFollow(link, options),
      (error) =>
        error.code === "ELOOP" &&
        // Node's own O_NOFOLLOW error names the path; the fallback's does not.
        (label === "O_NOFOLLOW" || !String(error.message).includes(root)),
    );
    assert.throws(() => openNoFollow(path.join(root, "missing"), options), {
      code: "ENOENT",
    });
  });
}
