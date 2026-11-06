// @ts-check
/** Social tables are additive: ordinary agent exports keep schema version 6.
 * @param {import("node:sqlite").DatabaseSync} db */
export function migrateHomeSocial(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS home_social_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 0, exchange_enabled INTEGER NOT NULL DEFAULT 0,
        recovery_epoch TEXT NOT NULL DEFAULT '', value TEXT NOT NULL DEFAULT '{}');
      INSERT OR IGNORE INTO home_social_policy(singleton) VALUES(1);
      CREATE TABLE IF NOT EXISTS home_social_blocks (
        actor_generation TEXT NOT NULL, target_generation TEXT NOT NULL, revision INTEGER NOT NULL,
        active INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(actor_generation,target_generation));
      CREATE TABLE IF NOT EXISTS home_social_invitations (
        id TEXT PRIMARY KEY, host_agent_id TEXT NOT NULL, host_generation TEXT NOT NULL,
        guest_agent_id TEXT NOT NULL, guest_generation TEXT NOT NULL,
        initiator_generation TEXT NOT NULL, recipient_generation TEXT NOT NULL,
        room_id TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
        source_labels TEXT NOT NULL DEFAULT '[]', audience TEXT NOT NULL,
        requested_scope TEXT NOT NULL, effective_scope TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','cancelled','expired','invalidated')),
        revision INTEGER NOT NULL DEFAULT 1, policy_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        recipient_viewed_at INTEGER, next_eligible_at INTEGER, decided_at INTEGER,
        closed_reason TEXT, body_cleared_at INTEGER,
        CHECK(host_generation<>guest_generation), CHECK(expires_at>created_at));
      CREATE UNIQUE INDEX IF NOT EXISTS home_social_pending_pair ON home_social_invitations(initiator_generation,recipient_generation) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS home_social_invitation_recipient ON home_social_invitations(recipient_generation,status,created_at);
      CREATE TABLE IF NOT EXISTS home_social_visits (
        id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL UNIQUE REFERENCES home_social_invitations(id),
        host_agent_id TEXT NOT NULL, host_generation TEXT NOT NULL,
        guest_agent_id TEXT NOT NULL, guest_generation TEXT NOT NULL, room_id TEXT NOT NULL,
        pair_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','ended','expired','invalidated')),
        revision INTEGER NOT NULL DEFAULT 1, next_sequence INTEGER NOT NULL DEFAULT 1,
        policy_revision INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER,
        ended_by TEXT, closed_reason TEXT, CHECK(host_generation<>guest_generation));
      CREATE UNIQUE INDEX IF NOT EXISTS home_social_active_pair ON home_social_visits(pair_key) WHERE status='active';
      CREATE TABLE IF NOT EXISTS home_social_grants (
        visit_id TEXT PRIMARY KEY REFERENCES home_social_visits(id), invitation_id TEXT NOT NULL,
        room_id TEXT NOT NULL, host_generation TEXT NOT NULL, guest_generation TEXT NOT NULL,
        scope TEXT NOT NULL, selected_item_revisions TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1, policy_revision INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER, fence INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS home_social_messages (
        id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES home_social_visits(id),
        author_agent_id TEXT NOT NULL, author_generation TEXT NOT NULL,
        sequence INTEGER NOT NULL, body TEXT NOT NULL DEFAULT '', source_labels TEXT NOT NULL,
        audience TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, retracted_at INTEGER, hidden_at INTEGER, body_cleared_at INTEGER,
        UNIQUE(visit_id,sequence));
      CREATE TABLE IF NOT EXISTS home_social_operations (
        actor_generation TEXT NOT NULL, actor_agent_id TEXT NOT NULL, request_id TEXT NOT NULL,
        kind TEXT NOT NULL, payload_hash TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('committed','not_sent','unknown')),
        result TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(actor_generation,request_id));
      CREATE TABLE IF NOT EXISTS home_social_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        entity_id TEXT NOT NULL, actor_generation TEXT NOT NULL, type TEXT NOT NULL,
        created_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS home_social_events_entity ON home_social_events(entity_id,sequence);
      CREATE TABLE IF NOT EXISTS home_social_read_cursors (
        viewer_generation TEXT NOT NULL, visit_id TEXT NOT NULL REFERENCES home_social_visits(id),
        last_read_sequence INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY(viewer_generation,visit_id));
      CREATE TABLE IF NOT EXISTS home_social_usage (
        actor_generation TEXT NOT NULL, day TEXT NOT NULL, scope TEXT NOT NULL,
        kind TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(actor_generation,day,scope,kind), CHECK(used>=0), CHECK(reserved>=0));
      CREATE TABLE IF NOT EXISTS home_social_contexts (
        id TEXT PRIMARY KEY, actor_generation TEXT NOT NULL, invitation_id TEXT, visit_id TEXT,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('compose','invitation','visit')),
        target_id TEXT NOT NULL, target_host_generation TEXT NOT NULL, target_guest_generation TEXT NOT NULL,
        binding_epoch INTEGER NOT NULL DEFAULT 0, fence INTEGER NOT NULL DEFAULT 0,
        epoch INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, policy_revision INTEGER NOT NULL,
        config_revision TEXT NOT NULL, history_cursor INTEGER NOT NULL DEFAULT 0,
        source_labels TEXT NOT NULL DEFAULT '[]', audience TEXT NOT NULL, updated_at INTEGER NOT NULL,
        CHECK(target_host_generation<>target_guest_generation),
        CHECK(actor_generation IN (target_host_generation,target_guest_generation)),
        CHECK((target_kind='compose' AND target_id=actor_generation AND invitation_id IS NULL AND visit_id IS NULL)
          OR (target_kind='invitation' AND invitation_id IS NOT NULL AND target_id=invitation_id AND visit_id IS NULL)
          OR (target_kind='visit' AND visit_id IS NOT NULL AND target_id=visit_id)));
      CREATE TABLE IF NOT EXISTS home_social_windows (
        id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES home_social_visits(id),
        proposer_generation TEXT NOT NULL, status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, terms_revision TEXT NOT NULL, terms TEXT NOT NULL,
        consent TEXT NOT NULL DEFAULT '[]', effective_limits TEXT NOT NULL,
        policy_revision INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
        fence INTEGER NOT NULL DEFAULT 0, turns_used INTEGER NOT NULL DEFAULT 0,
        turns_reserved INTEGER NOT NULL DEFAULT 0, resources_used TEXT NOT NULL DEFAULT '{}',
        resources_reserved TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, started_at INTEGER, deadline INTEGER, closed_at INTEGER, closed_reason TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS home_social_active_window ON home_social_windows(visit_id) WHERE status IN ('proposed','active');
      CREATE TABLE IF NOT EXISTS home_social_turns (
        id TEXT PRIMARY KEY, visit_id TEXT, window_id TEXT,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('compose','invitation','visit')),
        target_id TEXT NOT NULL, target_host_generation TEXT NOT NULL, target_guest_generation TEXT NOT NULL,
        actor_generation TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('async','window')),
        status TEXT NOT NULL, epoch INTEGER NOT NULL, fence INTEGER NOT NULL,
        policy_revision INTEGER NOT NULL, config_revision TEXT NOT NULL,
        batch_sealed INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
        resources_used TEXT NOT NULL DEFAULT '{}', resources_reserved TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        safe_error TEXT,
        CHECK(target_host_generation<>target_guest_generation),
        CHECK(actor_generation IN (target_host_generation,target_guest_generation)),
        CHECK((target_kind='compose' AND target_id=actor_generation AND visit_id IS NULL)
          OR (target_kind='invitation' AND visit_id IS NULL)
          OR (target_kind='visit' AND visit_id IS NOT NULL AND target_id=visit_id)),
        CHECK((mode='window' AND window_id IS NOT NULL AND target_kind='visit') OR (mode='async' AND window_id IS NULL)));
      CREATE UNIQUE INDEX IF NOT EXISTS home_social_actor_running ON home_social_turns(actor_generation) WHERE status='running';
      CREATE TABLE IF NOT EXISTS home_social_inference_reservations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_id TEXT NOT NULL,
        turn_id TEXT NOT NULL REFERENCES home_social_turns(id), actor_generation TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('async','window')),
        status TEXT NOT NULL CHECK(status IN ('reserved','completed','not_started','unknown')),
        reserved TEXT NOT NULL, actual TEXT, created_at INTEGER NOT NULL, settled_at INTEGER,
        UNIQUE(run_id,request_id));
      CREATE TABLE IF NOT EXISTS home_social_handoffs (
        turn_id TEXT PRIMARY KEY REFERENCES home_social_turns(id),
        actor_generation TEXT NOT NULL, visit_id TEXT NOT NULL REFERENCES home_social_visits(id),
        host_generation TEXT NOT NULL, guest_generation TEXT NOT NULL,
        value TEXT NOT NULL, source_ids TEXT NOT NULL, source_labels TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK(host_generation<>guest_generation),
        CHECK(actor_generation IN (host_generation,guest_generation)));
      CREATE INDEX IF NOT EXISTS home_social_handoff_lookup ON home_social_handoffs(actor_generation,visit_id,created_at);
      CREATE TABLE IF NOT EXISTS home_social_dispatches (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, turn_id TEXT NOT NULL UNIQUE,
        visit_id TEXT, window_id TEXT, actor_generation TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('compose','invitation','visit')),
        target_id TEXT NOT NULL, target_host_generation TEXT NOT NULL, target_guest_generation TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('async','window')), status TEXT NOT NULL,
        epoch INTEGER NOT NULL, fence INTEGER NOT NULL, not_before INTEGER NOT NULL,
        deadline INTEGER NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER, finished_at INTEGER,
        safe_error TEXT,
        CHECK(target_host_generation<>target_guest_generation),
        CHECK(actor_generation IN (target_host_generation,target_guest_generation)),
        CHECK((target_kind='compose' AND target_id=actor_generation AND visit_id IS NULL)
          OR (target_kind='invitation' AND visit_id IS NULL)
          OR (target_kind='visit' AND visit_id IS NOT NULL AND target_id=visit_id)),
        CHECK((mode='window' AND window_id IS NOT NULL AND target_kind='visit') OR (mode='async' AND window_id IS NULL)));
      CREATE INDEX IF NOT EXISTS home_social_dispatch_ready ON home_social_dispatches(status,not_before,deadline);
      CREATE TABLE IF NOT EXISTS home_social_outbox (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, entity_id TEXT NOT NULL,
        type TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL,
        epoch INTEGER NOT NULL, fence INTEGER NOT NULL, created_at INTEGER NOT NULL,
        claimed_at INTEGER, finished_at INTEGER);
      CREATE TABLE IF NOT EXISTS home_social_admin_access_audit (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL, action TEXT NOT NULL, authorized INTEGER NOT NULL,
        outcome TEXT NOT NULL, safe_error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS home_social_recovery_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), runtime_epoch TEXT NOT NULL,
        recovery_epoch TEXT NOT NULL, restored_at INTEGER);
      INSERT OR IGNORE INTO home_social_recovery_state VALUES(1,'','',NULL);
    `);
    /** @type {[string,string[]][]} */
    const bindings = [
      [
        "contexts",
        [
          "actor_generation",
          "target_kind",
          "target_id",
          "target_host_generation",
          "target_guest_generation",
          "invitation_id",
          "visit_id",
          "binding_epoch",
        ],
      ],
      [
        "turns",
        [
          "actor_generation",
          "target_kind",
          "target_id",
          "target_host_generation",
          "target_guest_generation",
          "visit_id",
          "window_id",
          "mode",
          "epoch",
        ],
      ],
      [
        "dispatches",
        [
          "turn_id",
          "actor_generation",
          "target_kind",
          "target_id",
          "target_host_generation",
          "target_guest_generation",
          "visit_id",
          "window_id",
          "mode",
          "epoch",
        ],
      ],
    ];
    for (const [table, immutable] of bindings) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS home_social_${table}_binding_immutable
        BEFORE UPDATE ON home_social_${table}
        WHEN ${immutable.map((column) => `new.${column} IS NOT old.${column}`).join(" OR ")}
          OR new.fence<old.fence
        BEGIN SELECT RAISE(ABORT,'SOCIAL_BINDING_IMMUTABLE'); END;`);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
