// QQ outage notices. When an agent's QQ goes offline nobody in QQ can tell,
// so another agent whose QQ is still online tells that agent's owners in a
// private chat. The line is the administrator's, sent by the program through
// the same outbox and limits as scheduled text; a blocked line is not retried.
import { allowed } from "./config.mjs";

// Per-connection, per-event cooldowns live in the store so a restart does not
// repeat a line that was already sent.
const STATE = "@outage-notice";
// Reviewed codes only; raw failure text never reaches QQ.
const REASONS = {
  QQ_OFFLINE: "QQ 已离线",
  QQ_ACCOUNT_MISMATCH: "登录的 QQ 号不对",
  QQ_AUTO_RECONNECT_EXHAUSTED: "自动重连失败",
};

export class OutageNotice {
  constructor(runtime) {
    this.runtime = runtime;
  }
  // The first other agent, in configuration order, whose QQ is connected,
  // that is not paused and may talk privately with this owner.
  sender(agent, owner) {
    const r = this.runtime;
    return r.config.agents.find(
      (a) =>
        a.id !== agent.id &&
        !a.paused &&
        r.transports.get(a.connectionId)?.connected === true &&
        allowed(a, "private:" + owner),
    );
  }
  // event is "offline", "exhausted" or "recovered"; code is a registered
  // error code that picks the {reason} wording. True once a line was tried.
  async send(connectionId, event, code) {
    const r = this.runtime;
    if (r.closed) return false;
    const agent = r.config.agents.find((a) => a.connectionId === connectionId),
      notice = agent?.behavior.outageNotice;
    if (!notice?.enabled) return false;
    if (event === "recovered" && !notice.notifyRecovered) return false;
    const mem = r.memory.bind(agent.id),
      state = mem.state(STATE),
      key = connectionId + ":" + event,
      now = r.now();
    if (now - (state[key] || 0) < notice.cooldownMs) return false;
    if (!agent.ownerIds.length)
      r.diagnostics.report(Error("OUTAGE_NOTICE_NO_OWNER"), {
        component: "runtime",
        agentId: agent.id,
      });
    const targets = [];
    for (const owner of new Set(agent.ownerIds)) {
      const sender = this.sender(agent, owner);
      if (sender) targets.push({ owner, sender });
      else
        r.diagnostics.report(Error("OUTAGE_NOTICE_NO_SENDER"), {
          component: "runtime",
          agentId: agent.id,
          conversation: "private:" + owner,
        });
    }
    if (!targets.length) return false;
    mem.setState(STATE, { ...state, [key]: now });
    const reason = REASONS[code] || REASONS.QQ_AUTO_RECONNECT_EXHAUSTED,
      text = (
        event === "recovered" ? notice.recoveredText : notice.text
      ).replace(/\{(agent|reason)\}/g, (_, name) =>
        name === "agent" ? agent.name : reason,
      );
    for (const { owner, sender } of targets) {
      const conversation = "private:" + owner;
      try {
        await r.withContext(sender.id, conversation, (ctx) =>
          r.send(ctx, {
            requestId: ["outage", connectionId, event, now, owner].join(":"),
            text,
          }),
        );
      } catch (error) {
        r.diagnostics.report(error, {
          component: "runtime",
          agentId: sender.id,
          conversation,
        });
      }
    }
    return true;
  }
}
