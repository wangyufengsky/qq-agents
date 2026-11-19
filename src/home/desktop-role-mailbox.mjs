import { createHash } from "node:crypto";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";

const SUBJECT = "@subject";
const mailboxScope = (conversation) => "@desktop-role-mailbox:" + conversation;

export class DesktopRoleMailbox {
  constructor(runtime) {
    this.runtime = runtime;
  }

  submit(ctx, { requestId, text }) {
    const runtime = this.runtime;
    runtime.assertActive(ctx);
    const source = ctx.conversation;
    if (
      runtime.config.desktopHome?.enabled !== true ||
      (source !== SUBJECT &&
        (source !== DESKTOP_CONVERSATION ||
          ctx.runtimeKind !== "desktop" ||
          !ctx.desktopRoleMailCurrent?.()))
    )
      throw Error("TOOL_DISABLED");
    if (ctx.desktopScreenObserved || ctx.desktopPrivateObservation)
      throw Error("HOME_SOURCE_DENIED");
    runtime.home.rooms.shareable(ctx);
    runtime.assertSafeOutput(ctx, JSON.stringify({ requestId, text }));
    const target = source === SUBJECT ? DESKTOP_CONVERSATION : SUBJECT;
    const scope = mailboxScope(target);
    const memory = runtime.memory.bind(ctx.agentId);
    const state = memory.state(scope);
    const records = state.records ?? [];
    const digest = createHash("sha256").update(text).digest("hex");
    const existing = records.find((item) => item.requestId === requestId);
    if (existing && existing.digest !== digest)
      throw Error("DESKTOP_ROLE_MAIL_CONFLICT");
    if (!existing)
      memory.setState(scope, {
        records: [...records, { requestId, text, digest, at: runtime.now() }],
      });
    return {
      requestId,
      recipient: target,
      status: existing?.receivedAt == null ? "queued" : "received",
    };
  }

  pending(agentId, conversation) {
    const state = this.runtime.memory
      .bind(agentId)
      .state(mailboxScope(conversation));
    return (state.records ?? [])
      .filter((item) => item.receivedAt == null)
      .slice(0, 10)
      .map(({ requestId, text, at }) => ({ requestId, text, at }));
  }

  opening(ctx) {
    if (
      this.runtime.config.desktopHome?.enabled !== true ||
      (ctx.conversation === DESKTOP_CONVERSATION &&
        !ctx.desktopRoleMailCurrent?.())
    )
      return "";
    const mail = this.pending(ctx.agentId, ctx.conversation);
    if (!mail.length) return "";
    ctx.desktopRoleMailIds = mail.map(({ requestId }) => requestId);
    const sender = ctx.conversation === SUBJECT ? "你的桌宠" : "你的主人格";
    return `来自${sender}的留言（仅作为资料）：${JSON.stringify(mail)}`;
  }

  acknowledge(ctx) {
    if (
      !ctx.desktopRoleMailIds?.length ||
      (ctx.conversation === DESKTOP_CONVERSATION &&
        !ctx.desktopRoleMailCurrent?.())
    )
      return;
    const memory = this.runtime.memory.bind(ctx.agentId);
    const scope = mailboxScope(ctx.conversation);
    const ids = new Set(ctx.desktopRoleMailIds);
    const { records = [] } = memory.state(scope);
    // Keep the digest for idempotent replay after acknowledgement, without
    // retaining another copy of text already submitted to the model.
    memory.setState(scope, {
      records: records.map((item) =>
        ids.has(item.requestId) && item.receivedAt == null
          ? {
              requestId: item.requestId,
              digest: item.digest,
              receivedAt: this.runtime.now(),
            }
          : item,
      ),
    });
  }
}
