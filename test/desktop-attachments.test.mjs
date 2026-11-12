import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import {
  DesktopAttachments,
  parseDesktopAttachment,
} from "../src/home/desktop-attachments.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

const desktopHome = new URL("../desktop/home/", import.meta.url);
const imageFixture = new URL("art/door.png", desktopHome);

test("desktop uploads require a local token, the room lease and an opted-in recipient", async (t) => {
  const cfg = config(1);
  cfg.desktopHome = {
    ...cfg.desktopHome,
    enabled: true,
    toolRoles: ["agent-0"],
  };
  cfg.agents[0].files = {
    ...cfg.agents[0].files,
    enabled: true,
    receive: true,
  };
  cfg.agents[0].behavior.imageInput.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const host = runtime.desktopVisits;
  const token = randomBytes(32).toString("hex");
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${await server.listen()}`;
  const client = randomUUID();
  const payload = {
    client,
    roomEpoch: randomUUID(),
    name: "测试资料.md",
    data: Buffer.from("合成测试附件正文").toString("base64"),
  };
  const request = (route, body, key = desktopToken(token)) =>
    fetch(base + "/api/desktop-home/" + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-desktop-home-token": key,
      },
      body: JSON.stringify(body),
    });
  const upload = (body = payload, key) => request("attachment", body, key);
  const sync = () => request("client", { client, action: "sync" });
  assert.equal((await upload(payload, token)).status, 401);
  const noLease = await upload();
  assert.equal((await noLease.json()).error, "DESKTOP_ATTACHMENT_UNAVAILABLE");
  const synced = await sync();
  assert.equal(synced.status, 200);
  const initial = await synced.json();
  payload.roomEpoch = initial.room.roomEpoch;
  assert.deepEqual(initial.room.attachmentInput, { text: false, image: false });
  const noRecipient = await upload();
  assert.equal(
    (await noRecipient.json()).error,
    "DESKTOP_ATTACHMENT_UNAVAILABLE",
  );
  const live = host.live;
  const role = live.room.roles[0];
  live.room.members[role.id] = "invited";
  live.admit(role);
  const backend = runtime.backendConnections.adapter(runtime.agent(role.id));
  let nativePrompt;
  let nativeImages;
  backend.runDesktop = (params) =>
    runNativeSocial(backend, params, async () => {}, "desktop");
  backend.run = async (params) => {
    nativePrompt = params.prompt;
    nativeImages = params.inputImages;
    await params.beforeInputSubmitted();
    params.onInputSubmitted?.();
    params.saveSession(
      params.session ?? { backend: "codex", id: "fixture-desktop-attachment" },
    );
    await params.callTool("desktop_room_decide", { action: "silent" });
  };
  const wrongClient = await upload({ ...payload, client: randomUUID() });
  assert.equal(
    (await wrongClient.json()).error,
    "DESKTOP_ATTACHMENT_UNAVAILABLE",
  );
  const invalidName = await upload({ ...payload, name: "../资料.md" });
  assert.equal((await invalidName.json()).error, "DESKTOP_ATTACHMENT_INVALID");
  const accepted = await upload();
  assert.equal(accepted.status, 200);
  const { room } = await accepted.json();
  assert.deepEqual(room.attachmentInput, { text: true, image: true });
  const [descriptor] = room.messages.at(-1).attachments;
  assert.deepEqual(
    { ...descriptor, id: undefined },
    {
      id: undefined,
      name: payload.name,
      mimeType: "text/markdown",
      bytes: Buffer.from(payload.data, "base64").length,
    },
  );
  assert.doesNotMatch(JSON.stringify(room), /合成测试附件正文/);
  await Promise.allSettled(runtime.work);
  assert.match(nativePrompt, /合成测试附件正文/);
  assert.equal(live.room.messages.at(-1).attachments[0].id, descriptor.id);
  const source = await readFile(imageFixture);
  const imageUpload = await upload({
    client,
    roomEpoch: payload.roomEpoch,
    name: "door.png",
    data: source.toString("base64"),
  });
  assert.equal(imageUpload.status, 200);
  const imageRoom = (await imageUpload.json()).room;
  await Promise.allSettled(runtime.work);
  assert.equal(nativeImages.length, 1);
  assert.equal(nativeImages[0].mimeType, "image/jpeg");
  assert(!nativePrompt.includes(nativeImages[0].data));
  assert(!JSON.stringify(imageRoom).includes(nativeImages[0].data));
  assert.equal(imageRoom.messages.at(-1).attachments[0].mimeType, "image/png");

  for (let index = 0; index < 6; index++) {
    const added = await upload({ ...payload, name: `资料-${index}.txt` });
    assert.equal(added.status, 200);
    await Promise.allSettled(runtime.work);
  }
  const currentAgent = runtime.agent(role.id);
  const oldestContent = () =>
    host.attachments.project(
      [{ attachments: [descriptor] }],
      runtime.config,
      currentAgent,
      live.visits.get(role.id),
    ).messages[0].attachments[0].text;
  assert.equal(oldestContent(), "合成测试附件正文");
  const countBeforeFailure = host.archive.history().length;
  runtime.memory.db.exec(`
    CREATE TEMP TRIGGER reject_fixture_attachment BEFORE INSERT ON desktop_messages
    WHEN json_extract(NEW.attachments, '$[0].name') = '失败.txt'
    BEGIN SELECT RAISE(ABORT, 'fixture upload failed'); END;
  `);
  const failed = await upload({ ...payload, name: "失败.txt" });
  assert.equal(failed.ok, false);
  assert.equal(host.archive.history().length, countBeforeFailure);
  assert.equal(oldestContent(), "合成测试附件正文");
  const afterFailure = await upload({ ...payload, name: "下一份.txt" });
  assert.equal(afterFailure.status, 200);
  await Promise.allSettled(runtime.work);
  assert.equal(host.archive.history().length, countBeforeFailure + 1);
  assert.equal(oldestContent(), undefined);

  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const oldAttachments = host.attachments;
  const prepare = oldAttachments.prepare.bind(oldAttachments);
  oldAttachments.prepare = async (...args) => {
    started.resolve();
    await finish.promise;
    return prepare(...args);
  };
  const racingUpload = upload();
  try {
    await Promise.race([
      started.promise,
      racingUpload.then(() => {
        throw Error("EXPECTED_PREPARATION");
      }),
    ]);
    host.client.expiresAt = runtime.now() - 1;
    const reopened = await sync().then((response) => response.json());
    assert.notEqual(reopened.room.roomEpoch, payload.roomEpoch);
    assert.equal(host.client.id, client);
    const reopenedRole = host.live.room.roles[0];
    host.live.room.members[reopenedRole.id] = "invited";
    host.live.admit(reopenedRole);
    const stale = await upload();
    assert.equal((await stale.json()).error, "DESKTOP_ATTACHMENT_UNAVAILABLE");
    assert.equal(host.archive.history().length, countBeforeFailure + 1);
    payload.roomEpoch = reopened.room.roomEpoch;
  } finally {
    finish.resolve();
  }
  const afterRoomChange = await racingUpload;
  assert.equal(
    (await afterRoomChange.json()).error,
    "DESKTOP_ATTACHMENT_UNAVAILABLE",
  );
  assert.equal(host.archive.history().length, countBeforeFailure + 1);
  assert.equal(runtime.maintenance.begin().pending, 0);
  assert.equal((await sync()).status, 200);
  const duringMaintenance = await upload();
  assert.equal((await duringMaintenance.json()).error, "UPDATE_IN_PROGRESS");
  assert.equal(host.archive.history().length, countBeforeFailure + 1);
});

test("desktop attachments are unavailable to other roles and later visits", async () => {
  const cfg = config(2);
  cfg.desktopHome = {
    ...cfg.desktopHome,
    enabled: true,
    toolRoles: ["agent-0"],
  };
  const [recipient, unselected] = cfg.agents;
  recipient.behavior.imageInput.enabled = true;
  unselected.behavior.imageInput.enabled = true;
  const attachment = new DesktopAttachments();
  const source = await readFile(imageFixture);
  const upload = parseDesktopAttachment({
    client: randomUUID(),
    roomEpoch: randomUUID(),
    name: "door.png",
    data: source.toString("base64"),
  });
  const normalized = await attachment.prepare(upload, cfg, [
    recipient,
    unselected,
  ]);
  const visit = {};
  const otherVisit = {};
  attachment.publish(
    normalized,
    cfg,
    new Map([
      [recipient.id, visit],
      [unselected.id, otherVisit],
    ]),
    () => true,
  );
  const messages = [
    { speaker: "管理员", text: "", attachments: [normalized.meta] },
  ];
  const selected = attachment.project(messages, cfg, recipient, visit);
  assert.equal(selected.images.length, 1);
  assert.equal(selected.images[0].mimeType, "image/jpeg");
  assert.equal(selected.messages[0].attachments[0].includedAsImage, true);
  assert(!JSON.stringify(selected.messages).includes(selected.images[0].data));
  const other = attachment.project(messages, cfg, unselected, otherVisit);
  assert.equal(other.images.length, 0);
  assert.equal(other.messages[0].attachments[0].contentUnavailable, true);
  const rejoined = attachment.project(messages, cfg, recipient, {});
  assert.equal(rejoined.images.length, 0);
  assert.equal(rejoined.messages[0].attachments[0].contentUnavailable, true);
  cfg.desktopHome.toolRoles = [];
  assert.throws(
    () => selected.assertCurrent(cfg, recipient, visit),
    /DESKTOP_ATTACHMENT_UNAVAILABLE/,
  );
});
