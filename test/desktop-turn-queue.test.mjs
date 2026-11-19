import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_ADMINISTRATOR,
  DesktopArchive,
} from "../src/home/desktop-archive.mjs";
import { DesktopTurnQueue } from "../src/home/desktop-turn-queue.mjs";

import { config, fixture } from "./helpers.mjs";

const minute = 60_000;

function setup() {
  let time = 1000;
  let sequence = 0;
  const queue = new DesktopTurnQueue({ now: () => time });
  return {
    queue,
    advance: (minutes) => (time += minutes * minute),
    publish: (sender) =>
      queue.publish(sender, (audience) => ({
        messageId: String(++sequence),
        audience,
      })),
  };
}

test("a message is addressed to the people present when it is published", () => {
  const { queue, publish } = setup();
  const firstVisit = queue.enter("first");
  const message = publish(DESKTOP_ADMINISTRATOR).message;
  assert.deepEqual(message.audience, ["first"]);
  queue.enter("second");
  assert.equal(queue.take("second"), undefined);
  const turn = queue.take("first");
  assert.deepEqual(
    turn.events.map(({ messageId }) => messageId),
    ["1"],
  );
  assert.equal(queue.leave("first"), true);
  assert.deepEqual(publish(DESKTOP_ADMINISTRATOR).message.audience, ["second"]);
  assert.notEqual(queue.enter("first"), firstVisit);
  publish(DESKTOP_ADMINISTRATOR);
  assert.equal(queue.take("first"), undefined);
  assert.equal(queue.current(turn), false);
  queue.finish(turn);
  assert.deepEqual(
    queue.take("first").events.map(({ messageId }) => messageId),
    ["3"],
  );
});

test("human messages and local touches queue behind a running turn", () => {
  const { queue, publish } = setup();
  const visitId = queue.enter("first");
  publish(DESKTOP_ADMINISTRATOR);
  const active = queue.take("first");
  publish(DESKTOP_ADMINISTRATOR);
  const drag = {
    kind: "drag",
    eventId: "drag-sample",
    from: { x: -20, y: 10 },
    to: { x: 150, y: 40 },
  };
  assert.equal(queue.enqueue("first", drag, visitId), true);
  assert.equal(queue.enqueue("first", drag, visitId), true);
  assert.equal(queue.take("first"), undefined);
  assert.equal(queue.current(active), true);
  queue.finish(active);
  const replay = queue.take("first");
  assert.deepEqual(
    replay.events.map(({ kind }) => kind),
    ["message", "message", "drag"],
  );
  assert.deepEqual(replay.events.at(-1), drag);
  queue.finish(replay, { submitted: true });
  assert.equal(queue.take("first"), undefined);
});

test("only published agent messages use the shared budget and both refresh paths restore it", () => {
  const { queue, advance, publish } = setup();
  queue.enter("first");
  queue.enter("second");
  assert.throws(() =>
    queue.publish("first", () => {
      throw Error("fixture publication failed");
    }),
  );
  assert.equal(queue.remaining(), 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(publish(i % 2 ? "first" : "second").status, "published");
  }
  assert.equal(publish("first").status, "awaiting-refresh");
  const finalListener = queue.take("second");
  assert.equal(finalListener.events.at(-1).messageId, "6");
  queue.finish(finalListener, { submitted: true });
  publish(DESKTOP_ADMINISTRATOR);
  assert.equal(queue.remaining(), 6);
  assert.ok(queue.take("second"));
  assert.equal(publish("first").status, "published");
  advance(9);
  assert.equal(queue.remaining(), 5);
  advance(1);
  assert.equal(queue.remaining(), 6);
});

test("roles can change their next autonomous wake while owner events still reach them", () => {
  const { queue, advance, publish } = setup();
  const firstVisit = queue.enter("first");
  queue.enter("second");
  assert.equal(queue.take("first"), undefined);
  advance(9);
  assert.equal(queue.take("first"), undefined);
  const now = advance(1);
  assert.deepEqual(queue.take("first").events, [{ kind: "autonomous" }]);
  const second = queue.take("second");
  assert.deepEqual(second.events, [{ kind: "autonomous" }]);
  queue.scheduleWake("second", now + 30 * minute);
  queue.finish(second, { submitted: true });
  advance(10);
  assert.equal(queue.take("second"), undefined);
  publish(DESKTOP_ADMINISTRATOR);
  const interruptedRest = queue.take("second");
  assert.deepEqual(
    interruptedRest.events.map(({ kind }) => kind),
    ["message"],
  );
  queue.finish(interruptedRest, { submitted: true });
  advance(20);
  assert.deepEqual(queue.take("second").events, [{ kind: "autonomous" }]);
  queue.leave("first");
  queue.enter("first");
  assert.equal(queue.scheduleWake("first", now, firstVisit), false);
});

test("the next opening includes the triggering message and drains only the resident's unread deliveries", (t) => {
  const { store } = fixture(t, { cfg: config(2) });
  const archive = new DesktopArchive(store);
  const publish = (actor, text, present) =>
    archive.publish({
      actor,
      speakerType: actor === DESKTOP_ADMINISTRATOR ? "administrator" : "agent",
      speaker: actor,
      text,
      now: 1000,
      present,
      identities: {},
      targets: [],
    });
  publish(DESKTOP_ADMINISTRATOR, "During the first visit", ["agent-0"]);
  publish(DESKTOP_ADMINISTRATOR, "While the first role is away", ["agent-1"]);
  publish("agent-0", "The first role already said this", ["agent-0"]);
  for (let i = 0; i < 24; i++)
    publish(DESKTOP_ADMINISTRATOR, "Backlog " + i, ["agent-0"]);
  const trigger = publish(DESKTOP_ADMINISTRATOR, "Current request", [
    "agent-0",
  ]);
  const page = archive.pending("agent-0", trigger.messageId);
  assert.equal(page.length, 24);
  assert.equal(page[0].text, "During the first visit");
  assert.equal(page.at(-1).messageId, trigger.messageId);
  assert.equal(archive.pending("agent-0", trigger.messageId).length, 24);
  archive.commitOpening("agent-0", page);
  assert.deepEqual(
    archive.pending("agent-0").map(({ text }) => text),
    ["Backlog 22", "Backlog 23"],
  );
  assert.deepEqual(
    archive.pending("agent-1").map(({ text }) => text),
    ["While the first role is away"],
  );
});
