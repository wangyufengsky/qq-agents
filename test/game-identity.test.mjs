import test from "node:test";
import assert from "node:assert/strict";
import { createP1aFixture } from "../src/games/fixtures/server.mjs";
import { secret } from "../src/games/core/value.mjs";

function fixture(t) {
  let now = 1_800_000_000_000;
  const service = createP1aFixture({ database: ":memory:", clock: () => now });
  t.after(() => service.close());
  const room = service.createRoom(),
    url = new URL(room.invitations[0].url, "http://example.test"),
    bindingId = url.searchParams.get("binding"),
    invite = url.searchParams.get("invite");
  return {
    ...service,
    ...room,
    bindingId,
    invite,
    advance: (ms) => {
      now += ms;
    },
    actor: (id) => service.kernel.actor(id),
  };
}
const rejects = (fn, code) => assert.throws(fn, (e) => e.message === code);

test("binding requires browser secret plus independently confirmed expected principal", (t) => {
  const f = fixture(t),
    browser = secret(),
    pending = f.identity.request(f.roomId, f.bindingId, f.invite, browser);
  rejects(
    () => f.identity.exchange(f.roomId, f.bindingId, browser),
    "JOIN_UNCONFIRMED",
  );
  rejects(
    () =>
      f.identity.confirm(
        f.roomId,
        f.bindingId,
        pending.challenge,
        f.actor("fixture-guest"),
      ),
    "BINDING_DENIED",
  );
  rejects(
    () =>
      f.identity.confirm(
        f.roomId,
        f.bindingId,
        "wrong",
        f.actor("fixture-owner"),
      ),
    "BINDING_DENIED",
  );
  f.identity.confirm(
    f.roomId,
    f.bindingId,
    pending.challenge,
    f.actor("fixture-owner"),
  );
  rejects(
    () => f.identity.exchange(f.roomId, f.bindingId, secret()),
    "JOIN_UNCONFIRMED",
  );
  const joined = f.identity.exchange(f.roomId, f.bindingId, browser),
    actor = f.identity.session(f.roomId, joined.session);
  assert.equal(
    f.kernel.view(f.roomId, actor).viewer,
    f.kernel.store.room(f.roomId).participants[0].participantId,
  );
  rejects(
    () => f.identity.exchange(f.roomId, f.bindingId, browser),
    "INVITATION_UNAVAILABLE",
  );
  const other = f.createRoom();
  rejects(
    () => f.identity.session(other.roomId, joined.session),
    "AUTH_REQUIRED",
  );
});

test("reissued invitation invalidates old challenge and rejoin rotates only the same seat session", (t) => {
  const f = fixture(t),
    browser = secret(),
    member = f.kernel.store.room(f.roomId).participants[0];
  const pending = f.identity.request(f.roomId, f.bindingId, f.invite, browser);
  const newInvite = f.identity.invite(
    f.roomId,
    f.actor("fixture-owner"),
    member.participantId,
  );
  rejects(
    () =>
      f.identity.confirm(
        f.roomId,
        f.bindingId,
        pending.challenge,
        f.actor("fixture-owner"),
      ),
    "INVITATION_UNAVAILABLE",
  );
  const join = (inv) => {
    const b = secret(),
      p = f.identity.request(f.roomId, inv.bindingId, inv.invite, b);
    f.identity.confirm(
      f.roomId,
      inv.bindingId,
      p.challenge,
      f.actor("fixture-owner"),
    );
    return f.identity.exchange(f.roomId, inv.bindingId, b);
  };
  const first = join(newInvite),
    revision = f.kernel.store.room(f.roomId).revision;
  const second = join(
    f.identity.invite(f.roomId, f.actor("fixture-owner"), member.participantId),
  );
  rejects(() => f.identity.session(f.roomId, first.session), "AUTH_REQUIRED");
  assert.equal(
    f.kernel.view(f.roomId, f.identity.session(f.roomId, second.session))
      .viewer,
    member.participantId,
  );
  assert.equal(f.kernel.store.room(f.roomId).revision, revision);
  const serialized = JSON.stringify(
    f.kernel.store.db.prepare("SELECT * FROM game_sessions").all(),
  );
  assert.equal(serialized.includes(second.session), false);
});

test("invitation deadlines and session deadlines remain separate", (t) => {
  const f = fixture(t),
    browser = secret();
  f.identity.request(f.roomId, f.bindingId, f.invite, browser);
  f.advance(15 * 60_000);
  rejects(
    () => f.identity.load(f.roomId, f.bindingId),
    "INVITATION_UNAVAILABLE",
  );
  f.kernel.sweep();
  assert.equal(f.kernel.store.room(f.roomId).lifecycle, "expired");
});

test("challenge cannot bind another room and owner cannot confirm the guest identity", (t) => {
  const f = fixture(t),
    url = new URL(f.invitations[1].url, "http://example.test"),
    binding = url.searchParams.get("binding"),
    browser = secret();
  const { challenge } = f.identity.request(
    f.roomId,
    binding,
    url.searchParams.get("invite"),
    browser,
  );
  rejects(
    () =>
      f.identity.confirm(
        f.roomId,
        binding,
        challenge,
        f.actor("fixture-owner"),
      ),
    "BINDING_DENIED",
  );
  const other = f.createRoom();
  rejects(
    () =>
      f.identity.confirm(
        other.roomId,
        binding,
        challenge,
        f.actor("fixture-guest"),
      ),
    "INVITATION_UNAVAILABLE",
  );
});
