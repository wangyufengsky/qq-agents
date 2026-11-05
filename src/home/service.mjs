import { HomeSocialService } from "./social-service.mjs";
// @ts-check
import { HomeRooms } from "./rooms.mjs";
import { randomUUID, createHash } from "node:crypto";
import { HomeStore } from "./store.mjs";
import { defaultLayout, validateLayout, homeTemplate } from "./layout.mjs";
export class HomeService {
  /** @param {any} runtime */
  constructor(runtime) {
    this.runtime = runtime;
    this.store = new HomeStore(runtime.memory.db);
    this.identityReady = false;
    this.social = new HomeSocialService(runtime, this);
    this.syncAgents();
    this.rooms = new HomeRooms(this);
  }
  syncAgents() {
    this.identityReady = false;
    const db = this.runtime.memory.db,
      ids = new Set(this.ids());
    this.social.store.transaction((now) => {
      for (const row of db
        .prepare("SELECT agent_id,generation,active FROM home_identities")
        .all())
        if (!ids.has(row.agent_id)) {
          if (row.active)
            this.social.store.invalidateIdentityInTransaction(
              { agentId: row.agent_id, generation: row.generation },
              "identity_invalidated",
              now,
            );
          db.prepare(
            "UPDATE home_identities SET active=0 WHERE agent_id=?",
          ).run(row.agent_id);
        }
      for (const id of ids) {
        const prior = db
          .prepare("SELECT active FROM home_identities WHERE agent_id=?")
          .get(id);
        if (!prior?.active)
          db.prepare(
            "INSERT OR REPLACE INTO home_identities(agent_id,generation,active) VALUES(?,?,1)",
          ).run(id, randomUUID());
      }
      this.social.syncPolicyInTransaction(now);
    });
    this.identityReady = true;
  }
  ids() {
    return this.runtime.config.agents.map((/** @type {any} */ a) => a.id);
  }
  /** @param {string} id */
  generation(id) {
    if (!this.identityReady) throw Error("HOME_UNAVAILABLE");
    if (!this.ids().includes(id)) throw Error("HOME_ROOM_NOT_FOUND");
    const row = this.runtime.memory.db
      .prepare(
        "SELECT generation FROM home_identities WHERE agent_id=? AND active=1",
      )
      .get(id);
    if (!row) throw Error("HOME_UNAVAILABLE");
    return row.generation;
  }
  rosterRevision() {
    return createHash("sha256")
      .update(
        JSON.stringify(
          this.ids().map((/** @type {string} */ id) => [
            id,
            this.generation(id),
          ]),
        ),
      )
      .digest("hex");
  }
  /** @param {string} [viewerAgentId] */
  overview(viewerAgentId) {
    const r = this.runtime;
    return {
      rosterRevision: this.rosterRevision(),
      boardEnabled: r.config.board.enabled,
      residents: r.config.agents.map((/** @type {any} */ a) => ({
        id: a.id,
        name: a.name,
        ...(viewerAgentId === undefined || viewerAgentId === a.id
          ? (() => {
              const item = this.rooms
                .display(a.id)
                .items.find((i) => i.slot === "tagline");
              return item?.visible ? { tagline: item.body } : {};
            })()
          : {}),
        state:
          a.paused || r.config.globalPaused
            ? "paused"
            : r.transports.get(a.connectionId)?.connected
              ? "online"
              : "offline",
      })),
    };
  }
  /** @param {string} type @param {string} [agentId] */
  target(type, agentId) {
    if (!["living", "hall", "room"].includes(type))
      throw Error("HOME_SCENE_INVALID");
    if (type === "room") return "room:" + this.generation(agentId || "");
    if (agentId !== undefined) throw Error("HOME_SCENE_INVALID");
    return "shared:" + type;
  }
  /** @param {string} type @param {string} [agentId] */
  read(type, agentId) {
    const key = this.target(type, agentId),
      result = this.store.read(key, defaultLayout(type));
    result.layout = this.visibleLayout(result.layout, type);
    return {
      ...result,
      ownerAgentId: agentId || null,
      identityGeneration:
        type === "room" ? this.generation(agentId || "") : null,
      contentRevision:
        type === "room"
          ? this.rooms.store.revision(this.generation(agentId || ""))
          : 0,
      rosterRevision: this.rosterRevision(),
      capabilities: { read: true, write: type !== "room", publish: false },
    };
  }
  /** Removed residents must not block restoration of the remaining public space.
   * @param {any} layout @param {string} type */
  visibleLayout(layout, type) {
    if (type !== "hall") return layout;
    const allowed = new Set(homeTemplate(type, this.ids()).allInstanceIds);
    return {
      ...layout,
      objects: Object.fromEntries(
        Object.entries(layout.objects).filter(([id]) => allowed.has(id)),
      ),
    };
  }
  /** @param {string} type @param {any} data */
  saveShared(type, data) {
    if (!["living", "hall"].includes(type)) throw Error("HOME_WRITE_DENIED");
    if (
      this.runtime.closed ||
      this.runtime.updateMaintenance ||
      this.runtime.maintenance.snapshot().active
    )
      throw Error("UPDATE_IN_PROGRESS");
    if (data.rosterRevision !== this.rosterRevision())
      throw Error("HOME_ROSTER_CONFLICT");
    const key = this.target(type);
    return {
      ...this.store.commit(
        key,
        data,
        defaultLayout(type),
        (v) =>
          validateLayout(
            data.undoRevision === undefined ? v : this.visibleLayout(v, type),
            type,
            this.ids(),
          ),
        this.runtime.now(),
      ),
      rosterRevision: this.rosterRevision(),
    };
  }
}
