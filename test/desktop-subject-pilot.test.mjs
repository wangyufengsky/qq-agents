import test from "node:test";
import assert from "node:assert/strict";
import {
  DesktopVisits,
  DESKTOP_VISIT_TOOL,
} from "../src/home/desktop-visits.mjs";
import { LiveRoom } from "../desktop/home/live-room.mjs";
import { createRoom } from "../desktop/home/room.mjs";
import { config, fixture, raw, settle } from "./helpers.mjs";

test("only the pilot subject can request one knock while the door is open", async (t) => {
  const cfg = config(2);
  for (const a of cfg.agents) a.subject.enabled = true;
  let status;
  const notifications = [];
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      if (p.conversation !== "@subject") return;
      const offered = p.tools.some(({ name }) => name === DESKTOP_VISIT_TOOL);
      if (offered) {
        status = (await p.callTool(DESKTOP_VISIT_TOOL, {})).status;
        if (status === "requested") assert.equal(notifications.length, 0);
      }
    },
  });
  assert(
    !f.runtime
      .toolsFor(f.runtime.agent("agent-0"), "@subject")
      .includes(DESKTOP_VISIT_TOOL),
  );
  const visits = new DesktopVisits(f.runtime, "agent-0", (event) =>
    notifications.push(event),
  );
  f.runtime.desktopVisits = visits;
  assert(
    !f.runtime
      .toolsFor(f.runtime.agent("agent-1"), "@subject")
      .includes(DESKTOP_VISIT_TOOL),
  );
  assert(
    !f.runtime
      .toolsFor(f.runtime.agent("agent-0"), "private:30000")
      .includes(DESKTOP_VISIT_TOOL),
  );
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(status, "door-unavailable");
  visits.setDoor(true, 4);
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(status, "requested");
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(status, "cooldown");
  assert.deepEqual(
    notifications.map(({ actor, epoch }) => ({ actor, epoch })),
    [{ actor: "agent-0", epoch: 4 }],
  );
});

test("eligible QQ intake aborts the desktop model and waits for cleanup before starting", async (t) => {
  const cfg = config(1);
  cfg.agents[0].behavior.preSleepWaitMs = 0;
  cfg.agents[0].behavior.batchWindowMs = 0;
  const started = [];
  const f = fixture(t, {
    cfg,
    run: async ({ conversation }) => {
      started.push(conversation);
    },
  });
  const visits = new DesktopVisits(f.runtime, "agent-0", () => {});
  f.runtime.desktopVisits = visits;
  const desktop = new AbortController();
  const release = visits.beginDesktop(desktop);
  await f.runtime.ingest(
    "qq-0",
    raw(51, {
      message_type: "private",
      sub_type: "friend",
      group_id: undefined,
    }),
  );
  assert.equal(desktop.signal.reason?.message, "DESKTOP_QQ_PRIORITY");
  assert.equal(visits.qqClaims, 1);
  await new Promise(setImmediate);
  assert.equal(started.length, 0);
  release();
  await settle(f.runtime);
  assert.deepEqual(started, ["private:30000"]);
});

test("busy mode rejects stale subject knocks and a later invite keeps the existing quota", async () => {
  let listener;
  let epoch;
  const room = createRoom();
  const live = new LiveRoom(
    room,
    {
      roles: ["fish"],
      subjectActor: "fish",
      onKnock(cb) {
        listener = cb;
      },
      setDoor(_open, value) {
        epoch = value;
      },
      retire() {},
      close() {},
    },
    () => {},
  );
  const send = (generation) =>
    listener({
      actor: "fish",
      epoch: generation,
      expiresAt: Date.now() + 5000,
    });
  live.setDoorMode("welcome");
  const first = epoch;
  send(first);
  assert.equal(room.members.fish, "home");
  assert.equal(live.knock.actor, "fish");
  live.setDoorMode("busy");
  assert.equal(live.knock, null);
  live.setDoorMode("welcome");
  send(first);
  assert.equal(live.knock, null);
  send(epoch);
  live.answerKnock(true);
  assert.equal(room.members.fish, "here");
  assert.equal(room.budget, 6);
});
