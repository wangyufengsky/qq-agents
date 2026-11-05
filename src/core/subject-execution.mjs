// @ts-check
/** Shared ownership for ordinary subject and isolated social execution. */
export class SubjectExecution {
  constructor() {
    this.owners = new Map();
  }
  /** @param {string} agentId */
  busy(agentId) {
    return this.owners.has(agentId);
  }
  /** @param {string} agentId @param {object} owner */
  acquire(agentId, owner) {
    if (this.owners.has(agentId)) return null;
    this.owners.set(agentId, owner);
    let released = false;
    return () => {
      if (!released && this.owners.get(agentId) === owner)
        this.owners.delete(agentId);
      released = true;
    };
  }
}
