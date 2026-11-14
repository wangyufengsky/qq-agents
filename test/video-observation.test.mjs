import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { mediaLease } from "../src/tools/media-lease.mjs";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { videoLinks } from "../src/video/bilibili.mjs";
import { probeVideo, videoOverview } from "../src/video/frames.mjs";
import { currentVideoRequest } from "../src/video/tools.mjs";
import {
  config,
  deliverFixtureToolOutput,
  fixture,
  raw,
  settle,
} from "./helpers.mjs";

const url = "https://www.bilibili.com/video/BV1xx411c7mD?p=2";
const text = (text) => ({ type: "text", data: { text } });
const card = (url) => ({
  type: "json",
  data: {
    data: JSON.stringify({
      app: "com.tencent.miniapp_01",
      meta: {
        detail_1: {
          appid: "fixture",
          url: "pages/video/index?scene=share",
          qqdocurl: url,
        },
      },
    }),
  },
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
      assert.equal(currentVideoRequest(runtime, ctx, row.id, 0)?.id, row.id);
      assert.equal(currentVideoRequest(runtime, ctx, randomUUID(), 0), null);
      assert.equal(currentVideoRequest(runtime, ctx, row.id, 1), null);
      const first = mem.db
        .prepare(
          "SELECT id FROM events WHERE kind='message.received' ORDER BY seq LIMIT 1",
        )
        .get();
      if (first.id !== row.id)
        assert.equal(currentVideoRequest(runtime, ctx, first.id, 0), null);
      await runtime.ingest("qq-0", {
        post_type: "notice",
        notice_type: "friend_recall",
        self_id: 10000,
        user_id: 30000,
        message_id: Number(row.message_id),
        time: 1800000000,
      });
      assert.equal(currentVideoRequest(runtime, ctx, row.id, 0), null);
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

function makeSample(file) {
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
}

test("QQ follow-up rewatch needs a delivered overview, a fresh human request, and an unrevoked source", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("video_read");
  cfg.agents[0].behavior.imageInput.enabled = true;
  cfg.agents[0].apps.enabled = true;
  cfg.agents[0].apps.platforms = ["bilibili"];
  const stages = [];
  let originalId, requestId;
  let acks = 0;
  const { runtime, root } = fixture(t, {
    cfg,
    async run(params) {
      const ctx = runtime.running.get("agent-0|private:30000");
      const row = runtime.memory
        .bind("agent-0")
        .db.prepare(
          "SELECT id,message_id FROM events WHERE kind='message.received' ORDER BY seq DESC LIMIT 1",
        )
        .get();
      const rewatch = {
        action: "rewatch",
        sourceId: originalId,
        startMs: 1000,
        endMs: 8000,
      };
      const seed = (sourceId, origin) => {
        ctx.videoSource = { sourceId, origin, file, duration: 61000 };
      };
      const overview = { action: "overview", sourceId: row.id };
      if (row.message_id === "910") {
        originalId = row.id;
        seed(originalId, url);
        const rawOverview = await runtime.callTool(
          ctx,
          "video_read",
          overview,
          { deferInput: true },
        );
        assert.equal(
          rawOverview.content.filter(({ type }) => type === "image").length,
          1,
        );
      } else if (row.message_id === "911") {
        assert.doesNotMatch(params.prompt, /近期已交付的视频概览/);
        await assert.rejects(
          params.callTool("video_read", { ...rewatch, requestId: row.id }),
          /VIDEO_SOURCE_DENIED/,
        );
        originalId = row.id;
        seed(originalId, url);
        const rawOverview = await runtime.callTool(
          ctx,
          "video_read",
          overview,
          { deferInput: true },
        );
        const output = await deliverFixtureToolOutput(
          {
            ...params,
            commitToolOutput(receipt, text) {
              acks += Number(params.commitToolOutput(receipt, text));
            },
          },
          rawOverview,
        );
        assert(output.content.some(({ type }) => type === "image"));
      } else if (row.message_id === "912") {
        assert.match(params.prompt, /近期已交付的视频概览/);
        requestId = row.id;
      } else {
        assert.match(params.prompt, new RegExp(originalId));
        await assert.rejects(
          params.callTool("video_read", rewatch),
          /VIDEO_SOURCE_DENIED/,
        );
        await assert.rejects(
          params.callTool("video_read", { ...rewatch, requestId }),
          /VIDEO_SOURCE_DENIED/,
        );
        await assert.rejects(
          params.callTool("video_read", {
            ...rewatch,
            requestId: row.id,
            linkIndex: 1,
          }),
          /VIDEO_SOURCE_DENIED/,
        );
        const other = runtime.makeContext("agent-0", "group:20000");
        try {
          await assert.rejects(
            runtime.callTool(other, "video_read", {
              ...rewatch,
              requestId: row.id,
            }),
            /VIDEO_SOURCE_DENIED/,
          );
        } finally {
          runtime.capabilities.delete(other.token);
        }
        seed(originalId, url);
        const valid = { ...rewatch, requestId: row.id };
        const details = await runtime.callTool(ctx, "video_read", valid, {
          deferInput: true,
        });
        assert.equal(
          details.content.filter(({ type }) => type === "image").length,
          4,
        );
        assert(details[mediaLease]());
        await assert.rejects(
          params.callTool("video_read", valid),
          /VIDEO_TURN_LIMIT/,
        );
        await runtime.ingest("qq-0", {
          post_type: "notice",
          notice_type: "friend_recall",
          self_id: 10000,
          user_id: 30000,
          message_id: 911,
          time: 1800000000,
        });
        assert.equal(details[mediaLease](), false);
        await assert.rejects(
          params.callTool("video_read", valid),
          /VIDEO_SOURCE_DENIED/,
        );
      }
      stages.push(row.message_id);
    },
  });
  const file = path.join(root, "sample.mp4");
  makeSample(file);
  for (const [i, message] of [
    [text(url)],
    [card(url)],
    [text("先聊点别的")],
    [text("刚才的视频，回看第一段")],
  ].entries()) {
    await runtime.ingest(
      "qq-0",
      raw(910 + i, { message_type: "private", group_id: undefined, message }),
    );
    await settle(runtime);
  }
  assert.deepEqual(stages, ["910", "911", "912", "913"]);
  assert.equal(acks, 1);
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
  makeSample(file);
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
  const followed = Promise.withResolvers();
  let previousId;
  backend.run = async (params) => {
    try {
      await params.beforeInputSubmitted();
      params.onInputSubmitted?.();
      const sourceId =
        previousId ?? live.room.messages.at(-1).attachments[0].id;
      const rewatch = {
        action: "rewatch",
        sourceId,
        startMs: 1000,
        endMs: 8000,
      };
      if (previousId) {
        assert.match(params.prompt, /最近已交付的视频概览/);
        const detail = await params.callTool("video_read", rewatch);
        assert.equal(
          detail.content.filter(({ type }) => type === "image").length,
          4,
        );
        await params.callTool("desktop_room_decide", { action: "silent" });
        followed.resolve();
        return;
      }
      assert.match(params.prompt, /videoAvailable/);
      await assert.rejects(
        params.callTool("video_read", rewatch),
        /VIDEO_TURN_LIMIT/,
      );
      const open = await params.callTool("video_read", {
        action: "overview",
        sourceId,
      });
      assert.equal(open.content.filter((x) => x.type === "image").length, 1);
      await deliverFixtureToolOutput(params, open);
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
      (previousId ? followed : examined).reject(error);
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
  previousId = sourceId;
  live.send("刚才那个附件，再看第一段");
  await followed.promise;
  const visit = live.visits.get(role.id);
  assert(host.attachments.videoFor(sourceId, role.id, visit));
  live.leave(role);
  assert.equal(
    host.attachments.videoFor(sourceId, role.id, live.visits.get(role.id)),
    undefined,
  );
});
