import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// Explicitly enabled local TTS. This generates speech, it does not transcribe it.
export async function synthesize(runtime, ctx, { text }) {
  const a = runtime.assertActive(ctx);
  if (!a.voice.tts.enabled) throw Error("TTS_DISABLED");
  runtime.assertSafeOutput(ctx, text);
  if (process.platform !== "darwin") throw Error("LOCAL_TTS_UNAVAILABLE");
  const dir = fs.mkdtempSync(path.join(runtime.voices.root, "tts-")),
    file = path.join(dir, "speech.wav");
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(
        "/usr/bin/say",
        [
          "-v",
          a.voice.tts.voice,
          "-o",
          file,
          "--file-format=WAVE",
          "--data-format=LEI16@24000",
          "-f",
          "-",
        ],
        { timeout: 60000, maxBuffer: 4096, signal: ctx.controller.signal },
        (err) => (err ? reject(Error("TTS_GENERATION_FAILED")) : resolve()),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    });
    runtime.assertActive(ctx);
    return await runtime.voices.put(a.id, fs.readFileSync(file), a.voice, {
      title: "本地生成语音",
      conversation: ctx.conversation,
      generatedBy: "macos-say",
      spokenText: text,
      protectedOperations: [...ctx.privateRead].some((x) =>
        /^(operations|operations-result):/.test(x),
      ),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
