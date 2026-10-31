(() => {
  const root = document.querySelector("main"),
    roomId = root.dataset.room,
    base = `/rooms/${roomId}`;
  const $ = (id) => document.getElementById(id),
    status = (text) => {
      $("status").textContent = text;
    };
  let snapshot = null,
    choice = null,
    busy = false,
    failedSync = 0,
    pending = null,
    timer = null;
  const pendingKey = `game-p1a:${roomId}:pending`;
  async function request(path, body) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      mode: "cors",
      credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(Error(data.error || "REQUEST_FAILED"), {
        status: response.status,
      });
    return data;
  }
  function render() {
    $("game").hidden = false;
    $("join").hidden = true;
    $("snapshot").textContent = JSON.stringify(snapshot, null, 2);
    $("confirm").disabled =
      busy ||
      !!pending ||
      !choice ||
      snapshot.lifecycle !== "active" ||
      !snapshot.view?.canChoose;
    $("retry").hidden = !pending;
    $("retry").disabled = busy;
    for (const b of document.querySelectorAll("[data-choice]"))
      b.disabled =
        busy ||
        !!pending ||
        snapshot.lifecycle !== "active" ||
        !snapshot.view?.canChoose;
    const controls = $("controls");
    controls.replaceChildren();
    if (snapshot.owner) {
      const types =
        snapshot.lifecycle === "waiting"
          ? ["start", "close"]
          : snapshot.lifecycle === "active"
            ? ["pause", "close"]
            : snapshot.lifecycle === "paused"
              ? ["resume", "close"]
              : [];
      for (const type of types) {
        const button = document.createElement("button");
        button.textContent = {
          start: "开始",
          pause: "暂停",
          resume: "恢复",
          close: "结束房间",
        }[type];
        button.disabled = busy || !!pending;
        button.onclick = () => submit(`room.${type}`, {});
        controls.append(button);
      }
    }
  }
  async function sync() {
    let next;
    try {
      next = await request("/view");
      failedSync = 0;
    } catch (error) {
      failedSync = Math.min(5, failedSync + 1);
      throw error;
    }
    if (snapshot?.revision !== next.revision) choice = null;
    if (pending && pending.viewer !== next.viewer) {
      pending = null;
      sessionStorage.removeItem(pendingKey);
    }
    snapshot = next;
    render();
  }
  async function exclusive(fn) {
    if (busy) return;
    busy = true;
    if (snapshot) render();
    try {
      await fn();
    } catch (error) {
      status(`操作未确认：${error.message}。可查询原操作或刷新。`);
    } finally {
      busy = false;
      if (snapshot) render();
    }
  }
  async function resolvePending() {
    if (!pending) return;
    try {
      try {
        await request(`/actions/${pending.request.actionId}`);
      } catch (error) {
        if (error.message !== "ACTION_UNCONFIRMED") throw error;
        await request("/actions", pending.request);
      }
    } catch (error) {
      if ([400, 401, 403, 409, 410, 413].includes(error.status)) {
        pending = null;
        sessionStorage.removeItem(pendingKey);
        choice = null;
        await sync();
        status(`操作已拒绝：${error.message}。请重新选择。`);
        return;
      }
      throw error;
    }
    pending = null;
    sessionStorage.removeItem(pendingKey);
    choice = null;
    await sync();
    status("操作已确认。");
  }
  function submit(type, payload) {
    return exclusive(async () => {
      if (pending) return;
      pending = {
        viewer: snapshot.viewer,
        request: {
          actionId: crypto.randomUUID(),
          expectedRevision: snapshot.revision,
          action: { type, payload },
        },
      };
      sessionStorage.setItem(pendingKey, JSON.stringify(pending));
      await resolvePending();
    });
  }
  $("join").onclick = () =>
    exclusive(async () => {
      const url = new URL(location.href),
        bindingId = url.searchParams.get("binding"),
        invite = url.searchParams.get("invite");
      await request("/join", { bindingId, invite });
      await request("/join", { bindingId });
      sessionStorage.removeItem(pendingKey);
      pending = null;
      history.replaceState(null, "", base);
      await sync();
      status("已加入。请等待房主开始。");
      schedule();
    });
  for (const button of document.querySelectorAll("[data-choice]"))
    button.onclick = () => {
      choice = button.dataset.choice;
      status(`已选择${choice === "sun" ? "太阳" : "月亮"}，请确认。`);
      render();
    };
  $("confirm").onclick = () => submit("game.choose", { symbol: choice });
  $("retry").onclick = () => exclusive(resolvePending);
  function schedule() {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(
      async () => {
        if (!busy) await exclusive(sync);
        schedule();
      },
      Math.min(30000, 2500 * 2 ** failedSync) * (0.8 + Math.random() * 0.4),
    );
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else schedule();
  });
  if (!new URL(location.href).searchParams.has("invite"))
    exclusive(async () => {
      try {
        pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
      } catch {
        sessionStorage.removeItem(pendingKey);
      }
      await sync();
      status("已同步。");
      schedule();
    });
})();
