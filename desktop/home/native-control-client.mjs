import { randomUUID } from "node:crypto";

function beforeExpiry(expiresAt) {
  return Number.isSafeInteger(expiresAt) && Date.now() < expiresAt;
}

export class NativeControlClient {
  #driver;
  #command;
  #claim;
  #result;
  #grant;
  #lastGrant;
  #scope;
  #pending;
  #cleanup;

  constructor(driver, { command, claim, result }) {
    this.#driver = driver;
    this.#command = command;
    this.#claim = claim;
    this.#result = result;
  }

  #closeScope() {
    const current = this.#scope;
    this.#scope = undefined;
    this.#pending?.controller.abort();
    if (current) {
      try {
        const closing = current.handle.close();
        this.#cleanup = closing && Promise.resolve(closing);
      } catch (error) {
        this.#cleanup = Promise.reject(error);
      }
      // A failed cleanup blocks the next scope without an unhandled rejection.
      void this.#cleanup?.catch(() => {});
    }
  }

  clear() {
    this.#grant = undefined;
    this.#closeScope();
  }

  async grant({ roomEpoch, agentId, source }) {
    const data = { roomEpoch, agentId, grantId: randomUUID() };
    const grant = { ...data, source, pending: true };
    this.#grant = grant;
    this.#lastGrant = data;
    try {
      const room = await this.#command("native-grant", data);
      grant.pending = false;
      if (
        this.#grant === grant &&
        room?.roomEpoch === roomEpoch &&
        room.nativeControl?.grantedAgentId === agentId
      )
        return "granted";
      if (this.#grant === grant) this.clear();
      return "unavailable";
    } catch {
      if (this.#grant === grant) this.clear();
      return "failed";
    }
  }

  async revoke(roomEpoch, agentId) {
    const grant = this.#lastGrant;
    this.clear();
    if (grant?.roomEpoch !== roomEpoch || grant.agentId !== agentId)
      return "unavailable";
    try {
      const room = await this.#command("native-revoke", {
        roomEpoch,
        grantId: grant.grantId,
      });
      return room?.nativeControl?.grantedAgentId ? "failed" : "revoked";
    } catch {
      return "failed";
    }
  }

  update(value, action) {
    const grant = this.#grant;
    if (!grant) return;
    const { room, nativeTurnId, nativeRequest } = value;
    if (
      room?.roomEpoch !== grant.roomEpoch ||
      !room.nativeControl?.eligible.includes(grant.agentId) ||
      (!grant.pending && room.nativeControl.grantedAgentId !== grant.agentId)
    ) {
      this.clear();
      return;
    }
    if (action !== "sync") return;

    if (
      (this.#scope && this.#scope.turnId !== nativeTurnId) ||
      (this.#pending && this.#pending.requestId !== nativeRequest?.requestId)
    )
      this.#closeScope();
    if (
      !nativeTurnId ||
      !nativeRequest ||
      !beforeExpiry(nativeRequest.expiresAt) ||
      this.#pending ||
      nativeRequest.turnId !== nativeTurnId ||
      nativeRequest.roomEpoch !== grant.roomEpoch ||
      nativeRequest.grantId !== grant.grantId ||
      nativeRequest.requestId === grant.lastRequest
    )
      return;
    grant.lastRequest = nativeRequest.requestId;
    void this.#execute(grant, nativeRequest);
  }

  async #execute(grant, request) {
    const { roomEpoch, grantId, requestId, turnId, action } = request;
    const identity = { roomEpoch, grantId, requestId };
    const controller = new AbortController();
    const { signal } = controller;
    this.#pending = { controller, requestId };
    const isCurrent = () =>
      this.#grant === grant &&
      !signal.aborted &&
      beforeExpiry(request.expiresAt);
    const beforeDispatch = async () => {
      if (!isCurrent()) return false;
      try {
        const receipt = await this.#claim(identity, isCurrent);
        // A sync reply can outlive its turn. Authorize at the mutation boundary.
        return (
          receipt?.accepted === true &&
          beforeExpiry(receipt.expiresAt) &&
          isCurrent()
        );
      } catch {
        return false;
      }
    };
    try {
      let result;
      try {
        // Opaque element references belong only to this turn and window.
        if (!this.#scope && this.#cleanup) await this.#cleanup;
        if (!isCurrent()) return;
        this.#scope ??= {
          turnId,
          handle: this.#driver.open(grant.source),
        };
        const { handle } = this.#scope;
        result =
          action.type === "observe"
            ? await handle.observe({ signal })
            : await handle.act(action, { signal, beforeDispatch });
      } catch {
        // Provider or OS error text can contain native window data.
      }
      if (isCurrent()) await this.#result({ ...identity, result }, isCurrent);
    } catch {
      // The host owns request expiry and rejects stale results.
    } finally {
      this.#pending = undefined;
    }
  }
}
