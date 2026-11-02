import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, config, context } from "./helpers.mjs";
import { wav } from "./audio-fixture.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";

for (const location of ["event", "payload"]) {
  test(`voice redownload with different bytes inherits peer-space protection from ${location}`, async (t) => {
    const cfg = config(1);
    cfg.agents[0].tools.push(
      "qq_voice_read",
      "qq_send_voice",
      "qq_list_voices",
    );
    const f = fixture(t, { cfg }),
      a = f.runtime.agent("agent-0");
    const original = wav(0.1),
      redownload = wav(0.2);
    f.runtime.voices = new VoiceStore(path.join(f.root, "voices"), {
      probe: async () => ({ ok: true, codec: "pcm", duration: 0.2 }),
      fetchBuffer: async () => redownload,
    });
    const old = await f.runtime.voices.put(a.id, original, a.voice, {
      protectedPeerQzoneTargets: ["30000"],
    });
    const event = {
      id: "fixture-received-voice",
      conversation: "private:30000",
      payload: {
        segments: [
          {
            type: "record",
            data: { url: "https://example.invalid/voice.wav" },
          },
        ],
      },
    };
    Object.assign(location === "event" ? event : event.payload, {
      protectedPeerQzoneTargets: ["30000"],
    });
    const audio = await f.runtime.voices.fromMessage(a.id, event, 0, a.voice);
    assert.notEqual(audio.id, old.id);
    assert.deepEqual(audio.protectedPeerQzoneTargets, ["30000"]);
    assert.deepEqual(
      Buffer.from(f.runtime.voices.read(a.id, audio.id).data, "base64"),
      redownload,
    );
    const owner = context(f.runtime, a.id, "private:30000");
    await f.runtime.callTool(owner, "qq_voice_read", { audioId: audio.id });
    assert(owner.privateRead.has("peer-qzone:30000"));
    f.runtime.voices = new VoiceStore(path.join(f.root, "voices"));
    const other = context(f.runtime, a.id, "group:20000");
    assert.equal(
      (await f.runtime.callTool(other, "qq_list_voices", {})).items.length,
      0,
    );
    await assert.rejects(
      f.runtime.callTool(other, "qq_voice_read", { audioId: audio.id }),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
    await assert.rejects(
      f.runtime.callTool(other, "qq_send_voice", {
        requestId: "voice-redownload-leak",
        audioId: audio.id,
      }),
      /PRIVATE_RECOLLECTION_REQUIRES_DISCLOSURE_GRANT|RECALL_SOURCE_NOT_ALLOWED/,
    );
    assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  });
}
