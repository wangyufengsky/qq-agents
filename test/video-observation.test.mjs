import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { videoLinks } from "../src/video/bilibili.mjs";
import { probeVideo, videoOverview } from "../src/video/frames.mjs";
import { authorizedVideoRequest } from "../src/video/tools.mjs";
import { config, fixture, raw, settle } from "./helpers.mjs";

const url = "https://www.bilibili.com/video/BV1xx411c7mD?p=2";
const text = (text) => ({ type: "text", data: { text } });
const card = (url) => ({
  type: "json",
  data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: url } } }) },
});

test("Bilibili sources preserve the selected part and remove tracking without permitting arbitrary URLs", () => {
  const payload = {
    segments: [
      text(url + "&share_source=qq"),
      card("https://b23.tv/sample?p=2&share_session_id=example"),
      card("https://local.bilibili.com/video/BV1xx411c7mD"),
      card("https://www.bilibili.com/video/BV1xx411c7mD?access_token=example"),
      card("https://www.bilibili.com/opus/10000"),
    ],
  };
  assert.deepEqual(videoLinks({ payload: JSON.stringify(payload) }), [
    url,
    "https://b23.tv/sample?p=2",
  ]);
});

test("QQ video tool sees only current human links and cards, and recall revokes access", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("video_read");
  cfg.agents[0].behavior.imageInput.enabled = true;
  cfg.agents[0].apps.enabled = true;
  cfg.agents[0].apps.platforms = ["bilibili"];
  const found = [];
  const { runtime } = fixture(t, {
    cfg,
    async run({ prompt }) {
      const ctx = runtime.running.get("agent-0|private:30000");
      const mem = runtime.memory.bind("agent-0");
      const row = mem.db
        .prepare(
          "SELECT id, message_id FROM events WHERE kind='message.received' ORDER BY seq DESC LIMIT 1",
        )
        .get();
      assert.match(prompt, new RegExp(row.id));
      assert.equal(authorizedVideoRequest(runtime, ctx, row.id, 0), url);
      assert.throws(
        () => authorizedVideoRequest(runtime, ctx, randomUUID(), 0),
        /VIDEO_SOURCE_DENIED/,
      );
      assert.throws(
        () => authorizedVideoRequest(runtime, ctx, row.id, 1),
        /VIDEO_SOURCE_DENIED/,
      );
      const first = mem.db
        .prepare(
          "SELECT id FROM events WHERE kind='message.received' ORDER BY seq LIMIT 1",
        )
        .get();
      if (first.id !== row.id)
        assert.throws(
          () => authorizedVideoRequest(runtime, ctx, first.id, 0),
          /VIDEO_SOURCE_DENIED/,
        );
      await runtime.ingest("qq-0", {
        post_type: "notice",
        notice_type: "friend_recall",
        self_id: 10000,
        user_id: 30000,
        message_id: Number(row.message_id),
        time: 1800000000,
      });
      assert.throws(
        () => authorizedVideoRequest(runtime, ctx, row.id, 0),
        /VIDEO_SOURCE_DENIED/,
      );
      found.push(row.message_id);
    },
  });
  for (const [i, message] of [[text(url)], [card(url)]].entries()) {
    await runtime.ingest(
      "qq-0",
      raw(905 + i, { message_type: "private", group_id: undefined, message }),
    );
    await settle(runtime);
  }
  assert.deepEqual(found, ["905", "906"]);
});

test("a selected desktop file reaches the role, and detail requires a current overview", async (t) => {
  const cfg = config(1);
  cfg.desktopHome = {
    ...cfg.desktopHome,
    enabled: true,
    toolRoles: ["agent-0"],
  };
  cfg.agents[0].behavior.imageInput.enabled = true;
  cfg.agents[0].tools.push("video_read");
  const { runtime, root } = fixture(t, { cfg });
  const file = path.join(root, "sample.mp4");
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=2",
    "-t",
    "61",
    "-c:v",
    "mpeg4",
    file,
  ]);
  const signal = AbortSignal.timeout(12000);
  const duration = await probeVideo(file, signal);
  assert.equal(duration, 61000);
  const overview = await videoOverview(
    file,
    duration,
    cfg.agents[0].behavior.imageInput,
    signal,
  );
  assert.equal(overview.length, 1);
  assert.equal(overview[0].timestampsMs.length, 2);
  const host = runtime.desktopVisits;
  const token = randomBytes(32).toString("hex");
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const base =
    "http://127.0.0.1:" + (await server.listen()) + "/api/desktop-home/";
  const client = randomUUID();
  const sync = await fetch(base + "client", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-desktop-home-token": desktopToken(token),
    },
    body: JSON.stringify({ client, action: "sync" }),
  }).then((r) => r.json());
  const { roomEpoch } = sync.room;
  const live = host.live;
  const role = live.room.roles[0];
  const backend = runtime.backendConnections.adapter(runtime.agent(role.id));
  backend.runDesktop = (params) =>
    runNativeSocial(backend, params, async () => {}, "desktop");
  const examined = Promise.withResolvers();
  backend.run = async (params) => {
    try {
      await params.beforeInputSubmitted();
      params.onInputSubmitted?.();
      const sourceId = live.room.messages.at(-1).attachments[0].id;
      assert.match(params.prompt, /videoAvailable/);
      const rewatch = {
        action: "rewatch",
        sourceId,
        startMs: 1000,
        endMs: 8000,
      };
      await assert.rejects(
        params.callTool("video_read", rewatch),
        /VIDEO_TURN_LIMIT/,
      );
      const open = await params.callTool("video_read", {
        action: "overview",
        sourceId,
      });
      assert.equal(open.content.filter((x) => x.type === "image").length, 1);
      const detailed = await params.callTool("video_read", rewatch);
      assert.equal(
        detailed.content.filter((x) => x.type === "image").length,
        4,
      );
      await assert.rejects(
        params.callTool("video_read", rewatch),
        /VIDEO_TURN_LIMIT/,
      );
      assert(
        !runtime
          .toolsForContext(
            cfg.agents[0],
            runtime.running.get("agent-0|@desktop"),
          )
          .includes("web_fetch"),
      );
      await params.callTool("desktop_room_decide", { action: "silent" });
      examined.resolve(sourceId);
    } catch (error) {
      examined.reject(error);
      throw error;
    }
  };
  const bytes = (await stat(file)).size;
  const upload = (key) =>
    fetch(base + "video", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes),
        "x-desktop-home-token": key,
        "x-desktop-client": client,
        "x-desktop-room-epoch": roomEpoch,
        "x-video-name": "sample.mp4",
      },
      body: createReadStream(file),
      duplex: "half",
    });
  assert.equal((await upload(token)).status, 401);
  live.room.members[role.id] = "invited";
  live.admit(role);
  const response = await upload(desktopToken(token));
  assert.equal(response.status, 200);
  const sourceId = await examined.promise;
  const visit = live.visits.get(role.id);
  assert(host.attachments.videoFor(sourceId, role.id, visit));
  live.leave(role);
  assert.equal(
    host.attachments.videoFor(sourceId, role.id, live.visits.get(role.id)),
    undefined,
  );
});
