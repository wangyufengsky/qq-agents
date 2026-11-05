// @ts-check
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";

const [traceFile, executable, ...args] = process.argv.slice(2);
const methods = new Set([
  "Browser.getVersion",
  "Target.setAutoAttach",
  "Browser.close",
]);
/** @type {Map<number,string>} */
const requests = new Map();
/** @type {Array<{direction:string,method:string,id:number|null}>} */
const frames = [];
const save = () => fs.writeFileSync(traceFile, JSON.stringify(frames));
save();
/** Observe fixed protocol identifiers without retaining or logging any payload.
 * Bytes are forwarded unchanged, including frames that have no diagnostic label.
 * @param {string} direction */
function observe(direction) {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 65536) {
        callback(Error("CDP_DIAGNOSTIC_FRAME_LIMIT"));
        return;
      }
      let end;
      while ((end = pending.indexOf(0)) >= 0) {
        let frame;
        try {
          frame = JSON.parse(pending.subarray(0, end).toString());
        } catch {
          callback(Error("CDP_DIAGNOSTIC_INVALID_FRAME"));
          return;
        }
        pending = pending.subarray(end + 1);
        const id = Number.isSafeInteger(frame.id) ? frame.id : null;
        if (direction === "send" && id !== null && methods.has(frame.method))
          requests.set(id, frame.method);
        const method =
          direction === "send"
            ? methods.has(frame.method)
              ? frame.method
              : "other"
            : id === null
              ? "event"
              : requests.get(id) || "other";
        if (frames.length < 20) {
          frames.push({ direction, method, id });
          save();
        }
      }
      callback(null, chunk);
    },
  });
}
const child = spawn(executable, args, {
  stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"],
  windowsHide: true,
});
child.on("error", () => process.exit(2));
child.on("exit", (code) => process.exit(code ?? 1));
const input = new net.Socket({ fd: 3, readable: true, writable: false });
const output = new net.Socket({ fd: 4, readable: false, writable: true });
const outgoing = observe("send"),
  incoming = observe("receive");
for (const stream of [
  input,
  output,
  outgoing,
  incoming,
  child.stdio[3],
  child.stdio[4],
])
  stream?.on("error", () => process.exit(3));
input
  .pipe(outgoing)
  .pipe(/** @type {import('node:stream').Writable} */ (child.stdio[3]));
/** @type {import('node:stream').Readable} */ (child.stdio[4])
  .pipe(incoming)
  .pipe(output);
