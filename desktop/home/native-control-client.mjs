import { createHash, randomUUID } from "node:crypto";

export function nativeControlTargetId({ id, pid, processInstance, app }) {
  const bytes = createHash("sha256")
    .update(JSON.stringify([id, pid, processInstance, app]))
    .digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = bytes.subarray(0, 16).toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function beforeExpiry(expiresAt) {
  return Number.isSafeInteger(expiresAt) && Date.now() < expiresAt;
}

class NativeControlSlot {
  #driver;
  #command;
  #claim;
  #result;
  #grant;
  #lastGrant;
  #revoking;
  #scope;
  #pending;
  #latest;
  #cleanup;
  #verifyTarget;
  #verifyGrant;

  constructor(driver, { command, claim, result, verifyTarget, verifyGrant }) {
    this.#driver = driver;
    this.#command = command;
    this.#claim = claim;
    this.#result = result;
    this.#verifyTarget = verifyTarget;
    this.#verifyGrant = verifyGrant;
  }

  selectedWindow(agentId, roomEpoch) {
    const grant = this.#grant;
    if (
      grant &&
      grant.agentId === agentId &&
      grant.roomEpoch === roomEpoch &&
      !grant.pending
    )
      return grant;
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
    this.#latest = undefined;
    this.#grant = undefined;
    this.#closeScope();
  }

  stopWindowTask(id) {
    if (
      this.#pending?.windowTaskId === id ||
      this.#scope?.windowTaskId === id
    ) {
      this.#latest = undefined;
      this.#closeScope();
    }
  }

  get active() {
    return Boolean(this.#grant);
  }

  target(agentId, grantId) {
    const grant = this.#grant;
    if (grant?.agentId === agentId && (!grantId || grant.grantId === grantId))
      return grant.source;
  }

  async grant({
    roomEpoch,
    agentId,
    source,
    confirmed,
    visitId,
    modeRevision,
    targetId,
  }) {
    if (this.#grant) return "unavailable";
    const data = { roomEpoch, agentId, grantId: randomUUID() };
    const unified = Boolean(targetId);
    const grant = { ...data, source, targetId, unified, pending: true };
    this.#grant = grant;
    this.#lastGrant = data;
    try {
      const room = await this.#command("native-grant", {
        ...data,
        ...(confirmed && { confirmed: true }),
        ...(targetId && { targetId }),
        ...(visitId && { visitId }),
        ...(modeRevision !== undefined && { modeRevision }),
      });
      grant.pending = false;
      if (
        this.#grant === grant &&
        room?.roomEpoch === roomEpoch &&
        (unified
          ? room.nativeControl?.grants?.some(
              (value) => value.grantId === grant.grantId,
            )
          : room.nativeControl?.grantedAgentId === agentId)
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
    const unified = this.#grant?.unified;
    this.#revoking = grant?.grantId;
    this.clear();
    if (
      !grant ||
      (!unified && grant.roomEpoch !== roomEpoch) ||
      grant.agentId !== agentId
    )
      return "unavailable";
    try {
      const room = await this.#command("native-revoke", {
        roomEpoch,
        grantId: grant.grantId,
      });
      return (
        unified
          ? room?.nativeControl?.grants?.some(
              (value) => value.grantId === grant.grantId,
            )
          : room?.nativeControl?.grantedAgentId
      )
        ? "failed"
        : "revoked";
    } catch {
      return "failed";
    }
  }

  update(value, action) {
    const grant = this.#grant;
    if (!grant) return;
    const { room } = value;
    if (grant.unified) {
      if (!room?.roomEpoch) {
        this.#latest = undefined;
        this.#closeScope();
        return;
      }
      const authorized = room.nativeControl?.grants?.some(
        ({ grantId, targetId }) =>
          grantId === grant.grantId && targetId === grant.targetId,
      );
      if (!grant.pending && !authorized) {
        this.clear();
        return;
      }
      grant.roomEpoch = room.roomEpoch;
      const nativeRequest = value.nativeRequests?.find(
        ({ grantId, targetId }) =>
          grantId === grant.grantId && targetId === grant.targetId,
      );
      value = { ...value, nativeRequest, nativeTurnId: nativeRequest?.turnId };
    }
    const { nativeTurnId, nativeRequest } = value;
    if (
      room?.roomEpoch !== grant.roomEpoch ||
      (!grant.unified &&
        (!room.nativeControl?.eligible.includes(grant.agentId) ||
          (!grant.pending &&
            room.nativeControl.grantedAgentId !== grant.agentId)))
    ) {
      this.clear();
      return;
    }
    if (action !== "sync") return;
    this.#latest = value;

    if (
      (this.#scope &&
        (nativeTurnId || !grant.unified) &&
        this.#scope.turnId !== nativeTurnId) ||
      (this.#pending &&
        !this.#pending.delivering &&
        this.#pending.requestId !== nativeRequest?.requestId)
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
    this.#pending = {
      controller,
      requestId,
      windowTaskId: request.windowTaskId,
    };
    const isCurrent = () =>
      this.#grant === grant &&
      request.roomEpoch === grant.roomEpoch &&
      !signal.aborted &&
      beforeExpiry(request.expiresAt);
    const needsVerification = this.#verifyGrant || request.windowTaskId;
    const verify = async () =>
      (!this.#verifyGrant || (await this.#verifyGrant(grant, signal))) &&
      (!request.windowTaskId || (await this.#verifyTarget?.(request, signal)));
    let claimed = false;
    const beforeDispatch = async () => {
      if (!isCurrent()) return false;
      if ((needsVerification && !(await verify())) || !isCurrent())
        return false;
      try {
        const receipt = await this.#claim(identity, isCurrent);
        claimed = receipt?.accepted === true;
        // A sync reply can outlive its turn. Authorize at the mutation boundary.
        return (
          receipt?.accepted === true &&
          beforeExpiry(receipt.expiresAt) &&
          isCurrent() &&
          (!needsVerification || (await verify())) &&
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
          windowTaskId: request.windowTaskId,
          handle: this.#driver.open(grant.source, { unified: grant.unified }),
        };
        const { handle } = this.#scope;
        if (action.type === "observe") {
          if ((!needsVerification || (await verify())) && isCurrent())
            result = await handle.observe({ signal });
          if (result && needsVerification && !(await verify()))
            result = undefined;
        } else result = await handle.act(action, { signal, beforeDispatch });
      } catch {
        // Provider or OS error text can contain native window data.
      }
      if (isCurrent()) {
        this.#pending.delivering = true;
        await this.#result({ ...identity, result }, isCurrent);
      } else if (claimed && this.#revoking === grantId)
        await this.#result(
          { ...identity, result },
          () => this.#revoking === grantId,
        );
    } catch {
      // The host owns request expiry and rejects stale results.
    } finally {
      this.#pending = undefined;
      if (this.#latest) this.update(this.#latest, "sync");
    }
  }
}

export class NativeControlClient {
  #driver;
  #options;
  #legacy;
  #slots = new Map();

  constructor(driver, options) {
    this.#driver = driver;
    this.#options = options;
    this.#legacy = new NativeControlSlot(driver, options);
  }

  selectedWindow(agentId, roomEpoch, grantId) {
    if (grantId) {
      for (const slot of this.#slots.values()) {
        const grant = slot.selectedWindow(agentId, roomEpoch);
        if (grant?.grantId === grantId) return grant;
      }
      return;
    }
    return this.#legacy.selectedWindow(agentId, roomEpoch);
  }

  clear() {
    // Legacy mode and transient framework disconnects need not revoke choices
    // for real windows. Their target scopes are suspended until the next sync.
    this.#legacy.clear();
    for (const slot of this.#slots.values()) slot.update({}, "sync");
  }

  stopWindowTask(id) {
    this.#legacy.stopWindowTask(id);
  }

  target(agentId, grantId) {
    if (!grantId) return this.#legacy.target(agentId);
    for (const slot of this.#slots.values()) {
      const source = slot.target(agentId, grantId);
      if (source) return source;
    }
  }

  async grant(input) {
    if (!input.targetId) return this.#legacy.grant(input);
    const key = JSON.stringify([input.agentId, input.targetId]);
    if (this.#slots.has(key)) return "unavailable";
    const slot = new NativeControlSlot(this.#driver, this.#options);
    this.#slots.set(key, slot);
    const status = await slot.grant(input);
    if (status !== "granted") this.#slots.delete(key);
    return status;
  }

  async revoke(roomEpoch, agentId, grantId) {
    if (!grantId) return this.#legacy.revoke(roomEpoch, agentId);
    for (const [key, slot] of this.#slots) {
      if (slot.selectedWindow(agentId, roomEpoch)?.grantId !== grantId)
        continue;
      const status = await slot.revoke(roomEpoch, agentId);
      this.#slots.delete(key);
      return status;
    }
    // The framework can still revoke a stale target after the local client
    // restarts and no longer has a matching AX handle.
    try {
      const room = await this.#options.command("native-revoke", {
        roomEpoch,
        grantId,
      });
      return room?.nativeControl?.grants?.some(
        (value) => value.grantId === grantId,
      )
        ? "failed"
        : "revoked";
    } catch {
      return "failed";
    }
  }

  update(value, action) {
    this.#legacy.update(value, action);
    for (const [key, slot] of this.#slots) {
      slot.update(value, action);
      if (!slot.active) this.#slots.delete(key);
    }
  }
}
