import { allowed } from "./config.mjs";
import { knownErrorCodes } from "./error-codes.mjs";
import { sourceClass } from "./outbound-policy.mjs";
import { transcriptKey } from "../memory/store.mjs";

// A transcript is its own record, tied to the voice message it was made
// from; the message's body and segments are never rewritten.
const TRANSCRIPT_EPISTEMIC = "machine-transcription";
const MAX_TEXT = 4000;
const DOWNLOAD_MS = 30000;

// The transcription tool's answer as text. A JSON object with a text or
// transcript field is unwrapped; anything else is taken as the transcript.
export function transcriptText(result) {
  const pick = (value) =>
    [value?.text, value?.transcript].find(
      (v) => typeof v === "string" && v.trim(),
    );
  const structured = pick(result?.structuredContent);
  if (structured) return structured.trim();
  const text = (result?.content || [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (text.startsWith("{"))
    try {
      return (pick(JSON.parse(text)) ?? "").trim();
    } catch {
      // Not JSON: the text itself is the transcript.
    }
  return text;
}

// Settles with the promise, or rejects with `code` once `ms` pass or the
// signal aborts, whichever is first.
function bounded(promise, ms, signal, code) {
  let timer, abort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(code)), ms);
      abort = () => reject(Error("ABORTED"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  });
}

// Transcribes received voice through the administrator's MCP tool
// (agent.voice.asr). Runs beside message intake, never inside it: a failure
// leaves the original placeholder and one diagnostic.
export class VoiceTranscription {
  constructor(runtime) {
    this.runtime = runtime;
    this.jobs = new Map();
    this.calls = new Map();
  }
  // Why voice from this conversation cannot go out now: "paused" for a
  // deliberate stop (no diagnostic), a registered code otherwise, or null.
  blocked(a, conversation) {
    const r = this.runtime,
      policy = a.voice.asr;
    if (!policy.enabled) return "paused";
    if (
      r.closed ||
      r.reconfiguringAgents.has(a.id) ||
      r.config.mode !== "live" ||
      r.config.globalPaused ||
      a.paused ||
      !allowed(a, conversation)
    )
      return "paused";
    const state = r.memory.bind(a.id).state(conversation);
    if (state.paused) return "paused";
    // A conversation holding operations or private-repository material sends
    // nothing out unprompted, the same as autonomous network grants.
    if (
      (state.disclosureTaint || []).some((id) =>
        ["operations", "private-repository"].includes(
          sourceClass(r, { agentId: a.id }, id),
        ),
      )
    )
      return "VOICE_TRANSCRIPTION_DENIED";
    const backend = r.config.backends.find((b) => b.id === a.backendId);
    if (
      !backend?.toolServers.some(
        (s) => s.id === policy.serverId && s.allowedTools.includes(policy.tool),
      )
    )
      return "EXTERNAL_TOOL_DISABLED";
    return null;
  }
  // One external call per voice, counted per agent over the last hour.
  reserve(a) {
    const now = this.runtime.now(),
      times = (this.calls.get(a.id) || []).filter((t) => t > now - 3600000);
    if (times.length >= a.voice.asr.maxPerHour) return false;
    this.calls.set(a.id, [...times, now]);
    return true;
  }
  report(code, a, conversation, cause) {
    this.runtime.diagnostics.report(
      Error(knownErrorCodes.has(code) ? code : "VOICE_TRANSCRIPTION_FAILED", {
        cause,
      }),
      { component: "runtime", agentId: a.id, conversation },
    );
  }
  // Called once a message is archived. Returns the running job (the caller
  // may set job.reason when the message wakes the agent) or null.
  observe(a, e, archived) {
    if (
      !a.voice.asr.enabled ||
      e.kind !== "message.received" ||
      !e.segments.some((s) => s?.type === "record")
    )
      return null;
    const key = a.id + "|" + archived.id;
    if (this.jobs.has(key)) return this.jobs.get(key);
    const blocked = this.blocked(a, e.conversation);
    if (blocked) {
      if (blocked !== "paused") this.report(blocked, a, e.conversation);
      return null;
    }
    if (!this.reserve(a)) {
      this.report("VOICE_TRANSCRIPTION_BUDGET", a, e.conversation);
      return null;
    }
    const job = {
      key,
      agentId: a.id,
      conversation: e.conversation,
      eventId: archived.id,
      seq: archived.seq,
      senderId: e.senderId,
      reason: null,
      late: false,
      controller: new AbortController(),
    };
    this.jobs.set(key, job);
    this.runtime.memory.transcribing.add(key);
    job.done = this.run(job).finally(() => {
      this.jobs.delete(key);
      this.runtime.memory.transcribing.delete(key);
    });
    this.runtime.trackJob(job.done, a.id);
    return job;
  }
  async run(job) {
    const r = this.runtime,
      { signal } = job.controller;
    let a = r.agent(job.agentId);
    try {
      const policy = a.voice.asr,
        mem = r.memory.bind(a.id),
        row = mem.db
          .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
          .get(a.id, job.eventId),
        limits = {
          ...a.voice,
          maxBytes: Math.min(a.voice.maxBytes, policy.maxBytes),
          maxSeconds: Math.min(a.voice.maxSeconds, policy.maxSeconds),
        },
        downloadMs = Math.min(DOWNLOAD_MS, policy.timeoutMs);
      const audio = await bounded(
        r.voices.fromMessage(
          a.id,
          {
            id: row.id,
            conversation: row.conversation,
            payload: JSON.parse(row.payload),
          },
          0,
          limits,
          (params) =>
            r.transports
              .get(a.connectionId)
              .call("get_record", params, downloadMs, {
                maxBytes: Math.ceil(limits.maxBytes / 3) * 4 + 65536,
                signal,
              }),
        ),
        downloadMs + 15000,
        signal,
        "VOICE_TRANSCRIPTION_TIMEOUT",
      );
      // An opaque SILK file has no measurable length to hold to the limit.
      if (!(audio.duration > 0))
        throw Error("VOICE_TRANSCRIPTION_FORMAT_UNSUPPORTED");
      // The download took time: pause, protection, allowlist and limits are
      // checked again, and the call uses the settings in force now.
      a = r.agent(job.agentId);
      const blocked = this.blocked(a, job.conversation);
      if (blocked === "paused") return;
      if (blocked) throw Error(blocked);
      const current = a.voice.asr;
      if (audio.bytes > Math.min(a.voice.maxBytes, current.maxBytes))
        throw Error("AUDIO_TOO_LARGE");
      if (audio.duration > Math.min(a.voice.maxSeconds, current.maxSeconds))
        throw Error("AUDIO_TOO_LONG");
      const backend = r.backendConnections.adapter(a);
      if (!backend?.external) throw Error("EXTERNAL_TOOLS_UNAVAILABLE");
      const data = r.voices.read(a.id, audio.id),
        args = Object.fromEntries([
          ...Object.entries(current.arguments),
          [current.audioArgument, data.data],
          ...(current.mimeArgument
            ? [[current.mimeArgument, data.mimeType]]
            : []),
        ]),
        deadline = AbortSignal.timeout(current.timeoutMs),
        combined = AbortSignal.any([signal, deadline]);
      let result;
      try {
        result = await bounded(
          backend.external.call(current.serverId, current.tool, args, {
            signal: combined,
            timeoutMs: current.timeoutMs,
          }),
          current.timeoutMs + 1000,
          combined,
          "VOICE_TRANSCRIPTION_TIMEOUT",
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (deadline.aborted || error.message === "VOICE_TRANSCRIPTION_TIMEOUT")
          throw Error("VOICE_TRANSCRIPTION_TIMEOUT", { cause: error });
        throw Error(
          knownErrorCodes.has(error?.message)
            ? error.message
            : "VOICE_TRANSCRIPTION_FAILED",
          { cause: error },
        );
      }
      if (signal.aborted) return;
      if (result?.isError) throw Error("VOICE_TRANSCRIPTION_FAILED");
      const text = transcriptText(result);
      if (!text) throw Error("VOICE_TRANSCRIPTION_EMPTY");
      this.store(job, a, row, audio, text, {
        serverId: current.serverId,
        tool: current.tool,
      });
    } catch (error) {
      if (signal.aborted) return;
      this.report(error?.message, a, job.conversation, error);
    }
  }
  store(job, a, row, audio, text, service) {
    const r = this.runtime,
      mem = r.memory.bind(a.id);
    const record = mem.append({
      dedupe: transcriptKey(job.eventId),
      connectionId: row.connection_id,
      conversation: row.conversation,
      kind: "voice.transcript",
      direction: "internal",
      status: "observed",
      senderId: row.sender_id,
      occurredAt: row.occurred_at,
      body: text.slice(0, MAX_TEXT),
      payload: {
        sourceEventId: job.eventId,
        sourceMessageId: row.message_id,
        audioId: audio.id,
        duration: audio.duration,
        service,
        epistemic: TRANSCRIPT_EPISTEMIC,
        ...(text.length > MAX_TEXT ? { truncated: true } : {}),
      },
    });
    if (!record.inserted) return;
    // New content in the conversation: a turn waiting for messages sees it.
    const state = mem.state(job.conversation);
    mem.setState(job.conversation, {
      ...state,
      lastReceivedSeq: Math.max(state.lastReceivedSeq || 0, record.seq),
    });
    r.conversations.notify(a.id, job.conversation);
    // The voice woke the agent but its turn went ahead without the text (it
    // stopped waiting, or the message was already read): wake once more.
    if (!job.reason || !(job.late || (state.readThroughSeq || 0) >= job.seq))
      return;
    if (!r.writable(a, job.conversation))
      mem.setState(job.conversation, {
        ...mem.state(job.conversation),
        pendingWake: true,
      });
    r.conversations.request(a.id, job.conversation, job.reason, {
      seq: record.seq,
      senderId: job.senderId,
    });
  }
  // A turn about to start waits, at most voice.asr.waitMs, for transcripts
  // still running in its conversation, so it can read what was said. With
  // none running it returns nothing, and the turn goes on without yielding.
  settle(ctx) {
    const jobs = [...this.jobs.values()].filter(
      (j) => j.agentId === ctx.agentId && j.conversation === ctx.conversation,
    );
    return jobs.length ? this.wait(ctx, jobs) : undefined;
  }
  async wait(ctx, jobs) {
    const { signal } = ctx.controller;
    let timer, stop;
    await Promise.race([
      Promise.allSettled(jobs.map((j) => j.done)),
      new Promise((resolve) => {
        stop = resolve;
        timer = setTimeout(
          resolve,
          this.runtime.agent(ctx.agentId).voice.asr.waitMs,
        );
        signal.addEventListener("abort", resolve, { once: true });
      }),
    ]);
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    for (const j of jobs) if (this.jobs.has(j.key)) j.late = true;
  }
  cancel(agentId, conversation) {
    for (const job of this.jobs.values())
      if (
        job.agentId === agentId &&
        (conversation === undefined || job.conversation === conversation)
      )
        job.controller.abort();
  }
}
