(() => {
  const roomId = document.querySelector("main").dataset.room,
    base = `/rooms/${roomId}`,
    key = `game-play:${roomId}:pending`,
    $ = (id) => document.getElementById(id),
    status = (text) => {
      $("status").textContent = text;
    },
    coord = (i) =>
      `${String.fromCharCode(65 + (i % 15))}${Math.floor(i / 15) + 1}`;
  let sessionEstablished =
      document.querySelector("main").dataset.authenticated === "true",
    snapshot = null,
    selected = null,
    resigning = false,
    busy = false,
    pending = null,
    storageReady = true,
    fresh = false,
    failures = 0,
    timer = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(key) || "null");
    sessionStorage.setItem(`${key}:probe`, "1");
    sessionStorage.removeItem(`${key}:probe`);
  } catch {
    storageReady = false;
  }
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
  function clearSelection() {
    selected = null;
    resigning = false;
  }
  function writable() {
    return !!snapshot && fresh && storageReady && !busy && !pending;
  }
  function playable() {
    return (
      writable() && snapshot.lifecycle === "active" && snapshot.view?.canAct
    );
  }
  function select(index) {
    if (!playable() || snapshot.view.board[index]) return;
    selected = index;
    resigning = false;
    render();
  }
  function render() {
    $("join").disabled = busy;
    $("join").hidden = sessionEstablished;
    if (!snapshot) return;
    $("game").hidden = false;
    $("join").hidden = true;
    const view = snapshot.view,
      board = view?.board || Array(225).fill(0);
    $("ai-status").textContent = snapshot.execution
      ? `AI 状态：${snapshot.execution.status}${snapshot.execution.reason ? " · " + snapshot.execution.reason : ""}`
      : "";
    $("revision").textContent = `版本 ${snapshot.revision}`;
    $("lifecycle").textContent = {
      waiting: "等待开始",
      active: "对局进行中",
      paused: "已暂停",
      finished: "已结束",
      expired: "已过期",
    }[snapshot.lifecycle];
    $("summary").textContent =
      snapshot.lifecycle === "finished" && !view?.result
        ? "房主已结束房间 · 不计胜负"
        : !view
          ? "等待双方加入，房主开始。"
          : view.result
            ? view.result.kind === "draw"
              ? "满盘和棋"
              : `${view.result.winners.includes(snapshot.viewer) ? "你获胜了" : "对方获胜了"}${view.result.reasonCode === "RESIGNED" ? " · 认输结束" : " · 五连达成"}`
            : `你执${view.color === "black" ? "黑" : "白"} · ${view.canAct ? "轮到你" : "等待对方"}`;
    for (const cell of $("board").children) {
      const i = Number(cell.dataset.index),
        stone = board[i];
      cell.textContent = ["·", "●", "○"][stone];
      cell.className = `cell stone-${stone}${selected === i ? " selected" : ""}${view?.lastMove && view.lastMove.y * 15 + view.lastMove.x === i ? " last" : ""}`;
      cell.setAttribute(
        "aria-label",
        `${coord(i)} ${["空位", "黑子", "白子"][stone]}`,
      );
      cell.setAttribute("aria-pressed", String(selected === i));
      cell.disabled = !playable() || !!stone;
    }
    $("selection").textContent =
      selected === null
        ? "先点棋盘选位，再在放大区域核对，最后确认落点。"
        : `已选 ${coord(selected)}，请核对局部放大后确认。`;
    $("zoom").replaceChildren();
    if (selected !== null) {
      const left = Math.min(12, Math.max(0, (selected % 15) - 1)),
        top = Math.min(12, Math.max(0, Math.floor(selected / 15) - 1));
      for (let y = top; y < top + 3; y++)
        for (let x = left; x < left + 3; x++) {
          const index = y * 15 + x,
            stone = board[index],
            b = document.createElement("button");
          b.textContent = `${coord(index)} ${["·", "●", "○"][stone]}`;
          b.setAttribute(
            "aria-label",
            `放大 ${coord(index)} ${["空位", "黑子", "白子"][stone]}`,
          );
          b.classList.toggle("selected", selected === index);
          b.disabled = !playable() || !!stone;
          b.onclick = () => select(index);
          $("zoom").append(b);
        }
    }
    $("confirm").disabled = !playable() || selected === null;
    $("cancel").disabled = busy || selected === null;
    $("retry").hidden = !pending;
    $("retry").disabled = busy || !storageReady;
    $("resign").disabled = !playable();
    $("confirm-resign").hidden = $("cancel-resign").hidden = !resigning;
    $("confirm-resign").disabled = !playable();
    $("controls").replaceChildren();
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
        button.disabled = !writable();
        button.onclick = () => submit(`room.${type}`, {});
        $("controls").append(button);
      }
    }
    if (!storageReady)
      status(
        "浏览器无法保存待确认操作，已禁用提交。请换系统浏览器。未发送新的操作。",
      );
  }
  function forgetPending() {
    try {
      sessionStorage.removeItem(key);
      pending = null;
    } catch {
      storageReady = false;
      throw Error("LOCAL_STORAGE_UNAVAILABLE");
    }
  }
  async function sync() {
    try {
      const next = await request("/view");
      if (snapshot?.revision !== next.revision) clearSelection();
      if (pending && pending.viewer !== next.viewer) forgetPending();
      if (failures && !pending) status("连接已恢复，已重新同步。");
      snapshot = next;

      // Poll only queries an uncertain action; replay requires an explicit retry with its original envelope.
      if (pending) {
        try {
          const receipt = await request(`/actions/${pending.request.actionId}`);
          if (receipt.revision > snapshot.revision)
            snapshot = await request("/view");
          forgetPending();
          clearSelection();
          status("操作已确认。");
        } catch (error) {
          if (error.message !== "ACTION_UNCONFIRMED") throw error;
        }
      }
      fresh = true;
      failures = 0;
      render();
    } catch (error) {
      clearSelection();
      fresh = false;
      failures = Math.min(5, failures + 1);
      throw error;
    }
  }
  async function exclusive(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } catch (error) {
      status(
        `操作未确认：${error.message}。当前棋局可能已过时，请查询原操作或等待同步。`,
      );
    } finally {
      busy = false;
      render();
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
        forgetPending();
        clearSelection();
        await sync();
        status(`操作已拒绝：${error.message}。请重新选择。`);
        return;
      }
      fresh = false;
      throw error;
    }
    forgetPending();
    clearSelection();
    await sync();
    status("操作已确认。");
  }
  function submit(type, payload) {
    if (!writable()) return;
    return exclusive(async () => {
      const candidate = {
        viewer: snapshot.viewer,
        request: {
          actionId: crypto.randomUUID(),
          expectedRevision: snapshot.revision,
          action: { type, payload },
        },
      };
      try {
        sessionStorage.setItem(key, JSON.stringify(candidate));
      } catch {
        storageReady = false;
        throw Error("LOCAL_STORAGE_UNAVAILABLE");
      }
      pending = candidate;
      await resolvePending();
    });
  }
  const bindingKey = `game-play:${roomId}:binding`;
  let binding = null;
  try {
    binding = JSON.parse(sessionStorage.getItem(bindingKey) || "null");
  } catch {
    storageReady = false;
  }
  function showBinding() {
    $("binding").hidden = false;
    $("binding").textContent =
      `请回原 QQ 会话发送：确认游戏 ${roomId} ${binding.bindingId} ${binding.challenge}`;
    $("exchange").hidden = false;
    status("等待原 QQ 身份确认。确认后点击继续加入。");
  }
  async function joined() {
    sessionEstablished = true;
    history.replaceState(null, "", base);
    try {
      sessionStorage.removeItem(bindingKey);
    } catch {
      storageReady = false;
    }
    binding = null;
    $("binding").hidden = true;
    $("exchange").hidden = true;
    try {
      await sync();
      status("已加入，等待房主开始。");
    } finally {
      schedule();
    }
  }
  async function exchange() {
    await request("/join", { bindingId: binding.bindingId });
    await joined();
  }
  $("exchange").onclick = () => exclusive(exchange);
  $("join").onclick = () =>
    exclusive(async () => {
      if (!storageReady) throw Error("LOCAL_STORAGE_UNAVAILABLE");
      try {
        await request("/view");
        await joined();
        return;
      } catch (error) {
        if (error.message !== "AUTH_REQUIRED") throw error;
      }
      if (binding && binding.expiresAt > Date.now()) {
        try {
          await exchange();
          return;
        } catch (error) {
          if (error.message !== "JOIN_UNCONFIRMED") throw error;
        }
        showBinding();
        return;
      }
      const url = new URL(location.href),
        invite = url.searchParams.get("invite"),
        bindingId = url.searchParams.get("binding");
      binding = await request(
        "/join",
        invite ? { bindingId, invite } : { start: true },
      );
      sessionStorage.setItem(bindingKey, JSON.stringify(binding));
      showBinding();
    });
  if (binding && !sessionEstablished && binding.expiresAt > Date.now())
    showBinding();
  for (const cell of $("board").children)
    cell.onclick = () => select(Number(cell.dataset.index));
  $("confirm").onclick = () => {
    if (selected !== null && playable())
      void submit("game.place", {
        x: selected % 15,
        y: Math.floor(selected / 15),
      });
  };
  $("cancel").onclick = () => {
    clearSelection();
    render();
  };
  $("retry").onclick = () => exclusive(resolvePending);
  $("resign").onclick = () => {
    if (playable()) {
      clearSelection();
      resigning = true;
      render();
    }
  };
  $("confirm-resign").onclick = () => {
    if (resigning && playable()) void submit("game.resign", {});
  };
  $("cancel-resign").onclick = () => {
    clearSelection();
    render();
  };
  function schedule() {
    clearTimeout(timer);
    if (document.hidden || !sessionEstablished) return;
    timer = setTimeout(
      async () => {
        if (!busy) await exclusive(sync);
        schedule();
      },
      Math.min(25000, 2500 * 2 ** failures) * (0.8 + Math.random() * 0.4),
    );
  }
  function wake() {
    clearSelection();
    fresh = false;
    render();
    if (sessionEstablished) void exclusive(sync).finally(schedule);
  }
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    clearSelection();
    fresh = false;
    render();
    if (!document.hidden) wake();
  });
  window.addEventListener("orientationchange", () => {
    clearSelection();
    render();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) wake();
  });
  if (sessionEstablished)
    void exclusive(async () => {
      await sync();
      status("已同步。");
    }).finally(schedule);
})();
