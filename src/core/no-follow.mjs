// @ts-check
import fs from "node:fs";

const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
// Same code as O_NOFOLLOW's failure so callers map both the same way; no path
// in the message, which may end up in diagnostics.
const loop = () =>
  Object.assign(Error("ELOOP: refusing to follow a symbolic link"), {
    code: "ELOOP",
  });

/**
 * Open a file read-only without following a final symbolic link. Windows has
 * no O_NOFOLLOW (the constant is undefined there, so OR-ing it in silently
 * follows links): check the path with lstat first, then require the opened
 * descriptor to be that same file, so a link swapped in between is refused.
 * @param {string} file
 * @param {{ noFollowFlag?: number }} [options] tests pass 0 to take the
 *   Windows path on any platform
 * @returns {number} file descriptor; the caller closes it
 */
export function openNoFollow(file, { noFollowFlag = NOFOLLOW } = {}) {
  if (noFollowFlag)
    return fs.openSync(file, fs.constants.O_RDONLY | noFollowFlag | NONBLOCK);
  const checked = fs.lstatSync(file);
  if (checked.isSymbolicLink()) throw loop();
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw loop();
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}
