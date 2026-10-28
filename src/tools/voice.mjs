import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { atomicJSON } from "../core/config.mjs";
import {
  probeAudio,
  processAudioVolume,
  cleanupTemp,
} from "../../vendor/legacy/voice-core.js";
import { safeFetchBuffer } from "../../vendor/social-reader/safe-fetch.js";
import { openNoFollow } from "../core/no-follow.mjs";

export function audioType(b) {
  if (!Buffer.isBuffer(b) || b.length < 10) throw Error("INVALID_AUDIO");
  const s = b.toString("ascii", 0, 16);
  if (s.startsWith("RIFF") && s.slice(8, 12) === "WAVE")
    return ["wav", "audio/wav"];
  if (s.startsWith("OggS")) return ["ogg", "audio/ogg"];
  if (s.startsWith("fLaC")) return ["flac", "audio/flac"];
  if (s.startsWith("ID3") || (b[0] === 255 && (b[1] & 0xe0) === 0xe0))
    return ["mp3", "audio/mpeg"];
  if (s.startsWith("#!AMR")) return ["amr", "audio/amr"];
  if (s.includes("#!SILK_V3")) return ["silk", "audio/silk"];
  if (s.slice(4, 8) === "ftyp") return ["m4a", "audio/mp4"];
  throw Error("INVALID_AUDIO");
}
export class VoiceStore {
  constructor(
    root,
    {
      probe = probeAudio,
      process = processAudioVolume,
      fetchBuffer = safeFetchBuffer,
    } = {},
  ) {
    Object.assign(this, { root, probe, process, fetchBuffer });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  dir(agentId) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId)) throw Error("INVALID_AGENT");
    return path.join(this.root, agentId);
  }
  metadata(agentId, id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("INVALID_AUDIO_ID");
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.dir(agentId), id + ".json"), "utf8"),
      );
    } catch {
      throw Error("AUDIO_NOT_FOUND");
    }
  }
  async put(agentId, buffer, policy, meta = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length > policy.maxBytes)
      throw Error("AUDIO_TOO_LARGE");
    const [ext, mimeType] = audioType(buffer),
      dir = this.dir(agentId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = createHash("sha256").update(buffer).digest("hex"),
      file = path.join(dir, id + "." + ext);
    const staging = path.join(dir, randomUUID() + "." + ext);
    fs.writeFileSync(staging, buffer, { mode: 0o600 });
    let info;
    try {
      info =
        ext === "silk"
          ? { ok: true, codec: "silk", duration: null }
          : await this.probe(staging, {
              ffprobePath: policy.ffprobeCommand,
              tmpDir: dir,
            });
      if (!info.ok || !info.codec || (ext !== "silk" && !(info.duration > 0)))
        throw Error("AUDIO_PROBE_FAILED");
      if (info.duration > policy.maxSeconds) throw Error("AUDIO_TOO_LONG");
      fs.renameSync(staging, file);
    } finally {
      fs.rmSync(staging, { force: true });
    }
    let old;
    try {
      old = this.metadata(agentId, id);
    } catch {
      // No previous metadata: this is a new voice.
    }
    const sources = [...(old?.sources || [])];
    if (
      meta.conversation &&
      !sources.some(
        (s) =>
          s.conversation === meta.conversation &&
          s.eventId === meta.sourceEventId,
      )
    )
      sources.push({
        conversation: meta.conversation,
        eventId: meta.sourceEventId || null,
      });
    const entry = {
      ...old,
      id,
      ext,
      mimeType,
      bytes: buffer.length,
      duration: info.duration,
      codec: info.codec,
      title: String(meta.title || old?.title || "未命名语音").slice(0, 120),
      sources,
      ...(meta.generatedBy
        ? { generatedBy: String(meta.generatedBy).slice(0, 200) }
        : {}),
      ...(meta.spokenText
        ? {
            spokenText: String(meta.spokenText).slice(0, 2000),
            textSource: "tts-input-not-asr",
          }
        : {}),
      protectedOperations:
        old?.protectedOperations || meta.protectedOperations || false,
      protectedRepositories: [
        ...new Set([
          ...(old?.protectedRepositories || []),
          ...(meta.protectedRepositories || []),
        ]),
      ],
      createdAt: old?.createdAt || new Date().toISOString(),
    };
    atomicJSON(path.join(dir, id + ".json"), entry);
    return entry;
  }
  list(agentId, { query = "", offset = 0, limit = 30 } = {}) {
    const dir = this.dir(agentId);
    const rows = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
          .map((f) => this.metadata(agentId, f.slice(0, -5)))
          .filter((x) => x.title.includes(query))
      : [];
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    };
  }
  read(agentId, id) {
    const m = this.metadata(agentId, id);
    return {
      type: "audio",
      mimeType: m.mimeType,
      data: fs
        .readFileSync(path.join(this.dir(agentId), id + "." + m.ext))
        .toString("base64"),
    };
  }
  async segment(agentId, id, policy, options = {}) {
    const meta = this.metadata(agentId, id),
      file = path.join(this.dir(agentId), id + "." + meta.ext);
    let processed;
    try {
      processed = await this.process(file, {
        ...options,
        ffmpegPath: policy.ffmpegCommand,
        tmpDir: this.dir(agentId),
      });
      const bytes = fs.readFileSync(processed.path);
      if (bytes.length > policy.maxBytes) throw Error("AUDIO_TOO_LARGE");
      return {
        type: "record",
        data: { file: "base64://" + bytes.toString("base64") },
      };
    } finally {
      if (processed?.converted) cleanupTemp(processed.path, true);
    }
  }
  async fromMessage(agentId, event, index, policy, getRecord) {
    const segment = (event.payload?.segments || []).filter(
      (s) => s.type === "record",
    )[index];
    if (!segment) throw Error("VOICE_NOT_FOUND");
    const url = segment.data?.url;
    if (!url && !segment.data?.file) throw Error("VOICE_URL_UNAVAILABLE");
    // Native QQ gateways can return filesystem paths. Only an administrator's
    // explicit media directories grant access; the message cannot grant it.
    const local = !url || path.isAbsolute(url) || url.startsWith("file:");
    let result;
    if (local && getRecord && segment.data?.file) {
      let record;
      try {
        record = await getRecord({
          file: segment.data.file,
          out_format: "wav",
        });
      } catch {
        /* Gateways without get_record may use explicitly allowed local media roots. */
      }
      if (typeof record?.base64 === "string" && record.base64) {
        const encoded = record.base64.replace(/^base64:\/\//, "");
        if (encoded.length > Math.ceil(policy.maxBytes / 3) * 4)
          throw Error("AUDIO_TOO_LARGE");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
          throw Error("INVALID_AUDIO");
        result = Buffer.from(encoded, "base64");
      }
    }
    if (!result) {
      if (!url) throw Error("VOICE_URL_UNAVAILABLE");
      result = local
        ? this.readLocal(url, policy)
        : await this.fetchBuffer(url, policy.maxBytes);
    }
    return this.put(
      agentId,
      Buffer.isBuffer(result) ? result : result.buffer,
      policy,
      {
        sourceEventId: event.id,
        conversation: event.conversation,
        title: "收到的语音",
      },
    );
  }
  readLocal(url, policy) {
    let file;
    try {
      file = fs.realpathSync(
        url.startsWith("file:") ? fileURLToPath(url) : url,
      );
      const permitted = (policy.localRoots || []).some((root) => {
        if (!path.isAbsolute(root)) return false;
        const relative = path.relative(fs.realpathSync(root), file);
        return (
          relative &&
          relative !== ".." &&
          !relative.startsWith(".." + path.sep) &&
          !path.isAbsolute(relative)
        );
      });
      if (!permitted) throw Error();
    } catch {
      throw Error("VOICE_LOCAL_PATH_DENIED");
    }
    const fd = openNoFollow(file);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw Error("VOICE_LOCAL_PATH_DENIED");
      if (stat.size > policy.maxBytes) throw Error("AUDIO_TOO_LARGE");
      const bytes = Buffer.alloc(policy.maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!n) break;
        length += n;
      }
      if (length > policy.maxBytes) throw Error("AUDIO_TOO_LARGE");
      return bytes.subarray(0, length);
    } finally {
      fs.closeSync(fd);
    }
  }
}
