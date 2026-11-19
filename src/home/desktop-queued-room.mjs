import { DESKTOP_ADMINISTRATOR } from "./desktop-archive.mjs";
import { LiveRoom } from "./desktop-room.mjs";
import { addMessage } from "./desktop-room-state.mjs";

export class QueuedDesktopRoom extends LiveRoom {
  constructor(room, runner, onChange, queue) {
    super(room, runner, onChange);
    this.queue = queue;
  }

  admit(role) {
    super.admit(role);
    if (!this.visits.has(role.id) || this.queue.visit(role.id)) return;
    this.queue.enter(role.id);
    const pending = this.runner.pending(role.id);
    if (pending.length) this.#enqueuePending(role.id, pending);
    this.onChange();
    void this.advance();
  }

  leave(role, self = false) {
    this.queue.leave(role.id);
    super.leave(role, self);
  }

  send(text, attachments = []) {
    if (this.closed) return false;
    const content = text.trim();
    if ((!content && !attachments.length) || content.length > 1000)
      return false;
    return (
      this.#publish(DESKTOP_ADMINISTRATOR, content, attachments).status ===
      "published"
    );
  }

  say(actor, text, attachments = [], turnId) {
    if (this.closed || !this.visits.has(actor)) return { status: "away" };
    return this.#publish(actor, text, attachments, turnId);
  }

  #publish(actor, text, attachments, turnId) {
    const owner = actor === DESKTOP_ADMINISTRATOR;
    const published = this.queue.publish(actor, (present) =>
      addMessage(
        this.room,
        owner ? "admin" : actor,
        text,
        this.runner.now(),
        attachments,
        turnId,
        owner ? "administrator" : "agent",
        undefined,
        present,
      ),
    );
    if (published.status === "published") {
      this.onChange();
      void this.advance();
    }
    return published;
  }

  #enqueuePending(actor, messages) {
    const trigger =
      messages.findLast(({ speakerType }) => speakerType === "administrator") ??
      messages.at(-1);
    if (trigger)
      this.queue.enqueue(actor, {
        kind: "message",
        speaker: trigger.speakerType,
        messageId: trigger.messageId,
        eventId: "backlog:" + trigger.messageId,
      });
  }

  ownerEvent(actor, visit, event) {
    if (this.visits.get(actor) !== visit) return false;
    const accepted = this.queue.enqueue(actor, event);
    if (accepted) void this.advance();
    return accepted;
  }

  snapshot() {
    const { remaining, nextRefill } = this.queue.quota();
    return {
      ...super.snapshot(),
      budget: remaining,
      nextRefill,
      thinking: this.activities.keys().next().value ?? null,
    };
  }

  tick(now = this.runner.now()) {
    super.tick(now);
    for (const { id } of this.here()) {
      const mail = this.runner.roleMail?.(id);
      if (mail)
        this.queue.enqueue(id, { kind: "mail", eventId: "mail:" + mail });
    }
    void this.advance();
  }

  async advance() {
    if (this.closed) return;
    const jobs = [];
    for (const { id } of this.here()) {
      if (!this.runner.chatReady(id)) continue;
      const turn = this.queue.take(id);
      if (turn) jobs.push(this.#run(turn));
    }
    await Promise.all(jobs);
  }

  async #run(turn) {
    const { actor, events } = turn;
    const visit = this.visits.get(actor);
    const controller = new AbortController();
    const completion = Promise.withResolvers();
    const active = { actor, controller, done: completion.promise, turn };
    this.activities.set(actor, active);
    const current = () =>
      !this.closed &&
      !controller.signal.aborted &&
      this.visits.get(actor) === visit &&
      this.queue.current(turn);
    let submitted = false;
    let reply;
    this.onChange();
    try {
      // The admitted event is always sent alongside this role's earlier unread
      // messages. Presentation may advance only once the provider accepts it.
      const trigger =
        events.findLast(({ speaker }) => speaker === "administrator") ??
        events.findLast(({ kind }) => kind === "message");
      const messages = this.runner.pending(actor, trigger?.messageId);
      reply = await this.runner.run(
        {
          actor,
          kind: "chat",
          desktopUnified: true,
          startedAt: this.runner.now(),
          events: events.filter(({ kind }) => kind !== "message"),
          people: this.here().map(({ name }) => name),
          messages,
          continuity: this.runner.continuity(actor),
          isCurrent: current,
          onInputSubmitted: () => {
            submitted = true;
          },
        },
        controller.signal,
        current,
      );
      if (!current()) return;
      if (reply?.action === "say")
        this.say(actor, reply.text ?? "", reply.attachments, reply.turnId);
      if (reply?.action === "wait" || reply?.action === "rest")
        this.queue.scheduleWake(
          actor,
          this.runner.now() + reply.waitMinutes * 60_000,
          turn.visitId,
        );
      if (submitted) this.#enqueuePending(actor, this.runner.pending(actor));
    } catch (error) {
      if (current()) this.runner.onError?.(actor, error);
    } finally {
      if (this.activities.get(actor) === active) this.activities.delete(actor);
      this.queue.finish(turn, { submitted });
      completion.resolve();
      if (this.visits.get(actor) === visit) {
        if (reply?.action === "leave")
          this.leave(
            this.room.roles.find(({ id }) => id === actor),
            true,
          );
        this.onChange();
      }
      // Submissions may have queued an additional page; failures retry on the next tick.
      if (submitted && !this.closed) void this.advance();
    }
  }

  advanceActivity() {
    return this.advance();
  }
}
