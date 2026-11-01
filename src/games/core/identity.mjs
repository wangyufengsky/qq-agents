// @ts-check
import { randomUUID, randomInt } from "node:crypto";
import { digest, fail, secret } from "./value.mjs";

const ttl = 15 * 60_000,
  sessionTtl = 24 * 60 * 60_000;
export class GameIdentity {
  /* Public eligibility belongs to the host adapter, never to core storage. */
  /** @param {import('./kernel.mjs').GameKernel} kernel @param {{isPublicRoom?:(id:string)=>boolean,dualConfirmation?:boolean}} [options] */
  constructor(
    kernel,
    { isPublicRoom = () => false, dualConfirmation = false } = {},
  ) {
    this.kernel = kernel;
    this.isPublicRoom = isPublicRoom;
    this.dualConfirmation = dualConfirmation;
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
      if (
        data.tokenHash !== digest(token) ||
        (data.browserHash && data.browserHash !== digest(browser))
      )
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
  /** Public group links still require a challenge confirmed by the exact QQ sender.
   * @param {string} roomId @param {string} browser */
  requestPublic(roomId, browser) {
    const k = this.kernel;
    return k.store.transaction(() => {
      const room = k.store.room(roomId);
      k.checkTime(room);
      if (!this.isPublicRoom(roomId)) fail("INVITATION_REQUIRED", 403);
      if (!/^[A-Za-z0-9_-]{43}$/.test(browser))
        fail("INVITATION_UNAVAILABLE", 403);
      if (!["waiting", "active", "paused"].includes(room.lifecycle))
        fail("JOIN_DENIED", 403);
      const member = room.participants.find(
        (/** @type {any} */ p) => p.kind === "human",
      );
      if (!member || member.revoked || !k.allow(member.principalId, roomId))
        fail("JOIN_DENIED", 403);
      k.store.db
        .prepare(
          "DELETE FROM game_bindings WHERE room_id=? AND json_extract(data,'$.expiresAt')<=?",
        )
        .run(roomId, k.clock());
      const existing = k.store.db
        .prepare(
          "SELECT id,data FROM game_bindings WHERE room_id=? AND json_extract(data,'$.browserHash')=?",
        )
        .get(roomId, digest(browser));
      if (existing) {
        const data = JSON.parse(String(existing.data));
        // Reuse the same browser slot without displacing another pending confirmation.
        const challenge = secret();
        data.challengeHash = digest(challenge);
        data.confirmed = false;
        delete data.exchangeHash;
        k.store.db
          .prepare("UPDATE game_bindings SET data=? WHERE id=?")
          .run(JSON.stringify(data), existing.id);
        return {
          bindingId: String(existing.id),
          challenge,
          expiresAt: data.expiresAt,
        };
      }
      if (
        Number(
          k.store.db
            .prepare("SELECT count(*) AS n FROM game_bindings WHERE room_id=?")
            .get(roomId)?.n,
        ) >= 8
      )
        fail("BINDING_CAPACITY", 429);
      const bindingId = randomUUID(),
        challenge = secret(),
        expiresAt = k.clock() + 900000;
      const data = {
        principalId: member.principalId,
        participantId: member.participantId,
        tokenHash: null,
        browserHash: digest(browser),
        challengeHash: digest(challenge),
        confirmed: false,
        expiresAt,
      };
      k.store.db
        .prepare("INSERT INTO game_bindings VALUES(?,?,?)")
        .run(bindingId, roomId, JSON.stringify(data));
      return { bindingId, challenge, expiresAt };
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
      if (data.confirmed) fail("BINDING_DENIED", 403);
      const code = this.dualConfirmation
        ? String(randomInt(10000000, 100000000))
        : null;
      data.exchangeHash = code ? digest(code) : null;
      data.exchangeAttempts = 0;
      data.exchangeExpiresAt = k.clock() + 5 * 60_000;
      data.confirmed = true;
      k.store.db
        .prepare("UPDATE game_bindings SET data=? WHERE id=?")
        .run(JSON.stringify(data), bindingId);
      return { confirmed: true, code };
    });
  }
  /** @param {string} roomId @param {string} bindingId @param {string} browser @param {string} [code] */
  exchange(roomId, bindingId, browser, code = "") {
    const k = this.kernel;
    const result = k.store.transaction(() => {
      const room = k.store.room(roomId);
      k.checkTime(room);
      const data = this.load(roomId, bindingId);
      if (
        data.confirmed &&
        data.browserHash === digest(browser) &&
        this.dualConfirmation
      ) {
        if (
          !data.exchangeHash ||
          data.exchangeAttempts >= 5 ||
          data.exchangeExpiresAt <= k.clock()
        )
          return { error: "BINDING_CODE_EXPIRED" };
        if (data.exchangeHash !== digest(code)) {
          data.exchangeAttempts++;
          k.store.db
            .prepare("UPDATE game_bindings SET data=? WHERE id=?")
            .run(JSON.stringify(data), bindingId);
          // Return before throwing so the attempt counter commits with the same lock as exchange.
          return { error: "BINDING_CODE_INVALID" };
        }
      }
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
    if ("error" in result)
      return fail(result.error || "BINDING_CODE_INVALID", 403);
    return { session: result.session, expiresAt: result.expiresAt };
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
