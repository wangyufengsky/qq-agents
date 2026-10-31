// @ts-check
import { randomUUID } from "node:crypto";
import { digest, fail, secret } from "./value.mjs";

const ttl = 15 * 60_000,
  sessionTtl = 24 * 60 * 60_000;
export class GameIdentity {
  /** @param {import('./kernel.mjs').GameKernel} kernel */
  constructor(kernel) {
    this.kernel = kernel;
  }
  /** Internal adapter boundary; the host must authenticate the actual role before issuing actor.
   * @param {string} roomId @param {object} actor @param {string} agentId */
  confirmAgent(roomId, actor, agentId) {
    const k = this.kernel;
    return k.store.transaction(() => {
      const room = k.store.room(roomId),
        { member } = k.access(room, actor);
      k.checkTime(room);
      if (
        !member ||
        member.kind !== "ai" ||
        member.agentId !== agentId ||
        room.lifecycle !== "waiting"
      )
        fail("BINDING_DENIED", 403);
      if (!member.confirmed) {
        member.confirmed = true;
        room.revision++;
        k.notify(room, "participant_confirmed");
        k.store.save(room);
      }
      return { confirmed: true };
    });
  }
  /** Trusted invitation issuer. Tokens never enter the model-facing room result.
   * @param {string} roomId @param {object} owner @param {string} participantId */
  invite(roomId, owner, participantId) {
    const k = this.kernel;
    return k.store.transaction(() => {
      const room = k.store.room(roomId);
      k.checkTime(room);
      if (!k.access(room, owner).owner) fail("ROOM_CONTROL_DENIED", 403);
      if (["finished", "expired"].includes(room.lifecycle)) fail("ROOM_CLOSED");
      const p = room.participants.find(
        (/** @type {any} */ p) => p.participantId === participantId,
      );
      if (!p || p.revoked || p.kind !== "human")
        fail("INVALID_PARTICIPANT", 400);
      // Re-issue replaces all outstanding challenges for this seat, not its identity.
      k.store.db
        .prepare(
          "DELETE FROM game_bindings WHERE room_id=? AND json_extract(data,'$.principalId')=?",
        )
        .run(roomId, p.principalId);
      const token = secret(),
        bindingId = randomUUID();
      const data = {
        principalId: p.principalId,
        participantId,
        tokenHash: digest(token),
        browserHash: null,
        challengeHash: null,
        confirmed: false,
        expiresAt: k.clock() + ttl,
      };
      k.store.db
        .prepare("INSERT INTO game_bindings VALUES(?,?,?)")
        .run(bindingId, roomId, JSON.stringify(data));
      return { bindingId, invite: token, expiresAt: data.expiresAt };
    });
  }
  /** @param {string} roomId @param {string} bindingId @returns {any} */
  load(roomId, bindingId) {
    const row = this.kernel.store.db
      .prepare("SELECT data FROM game_bindings WHERE id=? AND room_id=?")
      .get(bindingId, roomId);
    if (!row) fail("INVITATION_UNAVAILABLE", 403);
    const data = JSON.parse(String(row.data));
    if (data.expiresAt <= this.kernel.clock())
      fail("INVITATION_UNAVAILABLE", 403);
    return data;
  }
  /** @param {string} roomId @param {string} bindingId @param {string} token @param {string} browser */
  request(roomId, bindingId, token, browser) {
    const k = this.kernel;
    return k.store.transaction(() => {
      const room = k.store.room(roomId);
      k.checkTime(room);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        !/^[A-Za-z0-9_-]{43}$/.test(browser)
      )
        fail("INVITATION_UNAVAILABLE", 403);
      const data = this.load(roomId, bindingId);
      if (data.tokenHash !== digest(token) || data.browserHash)
        fail("INVITATION_UNAVAILABLE", 403);
      const challenge = secret();
      data.browserHash = digest(browser);
      data.challengeHash = digest(challenge);
      k.store.db
        .prepare("UPDATE game_bindings SET data=? WHERE id=?")
        .run(JSON.stringify(data), bindingId);
      return { challenge, expiresAt: data.expiresAt };
    });
  }
  /** Host adapter must derive actor from the authenticated source message, never the browser.
   * @param {string} roomId @param {string} bindingId @param {string} challenge @param {object} actor */
  confirm(roomId, bindingId, challenge, actor) {
    const k = this.kernel;
    return k.store.transaction(() => {
      const room = k.store.room(roomId),
        access = k.access(room, actor);
      k.checkTime(room);
      const data = this.load(roomId, bindingId);
      if (
        data.principalId !== access.principal ||
        data.challengeHash !== digest(challenge) ||
        !data.browserHash ||
        !access.member ||
        access.member.revoked
      )
        fail("BINDING_DENIED", 403);
      data.confirmed = true;
      k.store.db
        .prepare("UPDATE game_bindings SET data=? WHERE id=?")
        .run(JSON.stringify(data), bindingId);
      return { confirmed: true };
    });
  }
  /** @param {string} roomId @param {string} bindingId @param {string} browser */
  exchange(roomId, bindingId, browser) {
    const k = this.kernel;
    return k.store.transaction(() => {
      const room = k.store.room(roomId);
      k.checkTime(room);
      const data = this.load(roomId, bindingId);
      if (!data.confirmed || data.browserHash !== digest(browser))
        fail("JOIN_UNCONFIRMED", 403);
      const { member } = k.access(room, k.actor(data.principalId));
      if (
        !member ||
        member.kind !== "human" ||
        ["finished", "expired"].includes(room.lifecycle)
      )
        fail("JOIN_DENIED", 403);
      if (!member.confirmed) {
        if (room.lifecycle !== "waiting") fail("JOIN_DENIED", 403);
        member.confirmed = true;
        room.revision++;
        k.notify(room, "participant_confirmed");
        k.store.save(room);
      }
      k.store.db
        .prepare(
          "DELETE FROM game_sessions WHERE room_id=? AND json_extract(data,'$.principalId')=?",
        )
        .run(roomId, data.principalId);
      const session = secret(),
        expiresAt = k.clock() + sessionTtl;
      k.store.db
        .prepare("INSERT INTO game_sessions VALUES(?,?,?)")
        .run(
          digest(session),
          roomId,
          JSON.stringify({ principalId: data.principalId, expiresAt }),
        );
      k.store.db.prepare("DELETE FROM game_bindings WHERE id=?").run(bindingId);
      return { session, expiresAt };
    });
  }
  /** @param {string} roomId @param {string} token */
  session(roomId, token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail("AUTH_REQUIRED", 401);
    const row = this.kernel.store.db
      .prepare("SELECT data FROM game_sessions WHERE hash=? AND room_id=?")
      .get(digest(token), roomId);
    if (!row) fail("AUTH_REQUIRED", 401);
    const data = JSON.parse(String(row.data));
    if (data.expiresAt <= this.kernel.clock()) fail("AUTH_REQUIRED", 401);
    const actor = this.kernel.actor(data.principalId);
    this.kernel.access(this.kernel.store.room(roomId), actor);
    return actor;
  }
}
