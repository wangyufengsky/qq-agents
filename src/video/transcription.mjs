import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readVideoProcess, videoAudioClip } from "./frames.mjs";
import { srtCues } from "./subtitles.mjs";

export async function transcribeVideoSegment(audio, startMs, endMs, signal) {
  const model = process.env.QQ_VIDEO_WHISPER_MODEL;
  if (!model) return { status: "transcription-unconfigured" };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(38_000)]);
  const dir = await mkdtemp(path.join(tmpdir(), "qq-video-asr-"));
  try {
    const source = await audio(dir, deadline);
    if (!source) return { status: "transcription-unavailable" };
    const wav = path.join(dir, "clip.wav");
    await videoAudioClip(source, startMs, endMs, wav, deadline);
    const prefix = path.join(dir, "clip");
    await readVideoProcess(
      process.env.QQ_VIDEO_WHISPER_CLI || "whisper-cli",
      [
        "-m",
        model,
        "-f",
        wav,
        "-l",
        "auto",
        "-t",
        "4",
        "-ng",
        "-osrt",
        "-of",
        prefix,
      ],
      deadline,
      256 * 1024,
    );
    const srt = prefix + ".srt";
    if ((await stat(srt)).size > 64 * 1024)
      return { status: "transcription-unavailable" };
    const cues = srtCues(await readFile(srt, "utf8"), endMs, startMs);
    return cues.length
      ? { status: "machine-transcription", cues }
      : { status: "transcription-empty" };
  } catch {
    signal.throwIfAborted();
    return { status: "transcription-unavailable" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
