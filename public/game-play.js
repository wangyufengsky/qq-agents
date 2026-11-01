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
  const messages = {
    AUTH_REQUIRED: "网页身份已过期，请重新加入",
    JOIN_UNCONFIRMED: "请先回原 QQ 会话确认身份",
    BINDING_CODE_INVALID: "验证码不正确，请核对 QQ 回执",
    BINDING_CODE_EXPIRED: "验证码已过期或尝试过多，请重新获取邀请",
    INVITATION_UNAVAILABLE: "邀请已失效，请在原 QQ 会话重新加入",
    RATE_LIMITED: "请求过于频繁，请稍后再试",
    BINDING_CAPACITY:
      "待确认人数已满，请回原 QQ 会话发送：重新加入游戏 " + roomId + "",
    GAME_BLOCKED: "当前角色或房间暂不可用",
    REVISION_CONFLICT: "棋局已有更新",
    NOT_YOUR_TURN: "当前不是你的回合",
    LOCAL_STORAGE_UNAVAILABLE: "浏览器无法保存操作，请换系统浏览器",
    GAME_RETRY_LIMIT: "本回合已达到玩家重试上限，请停止重试并核对状态",
    GAME_OUTCOME_UNKNOWN: "AI 执行结果尚不明确，请等待核对，不能再次执行",
    GAME_BUDGET_EXHAUSTED: "游戏调用额度已用尽，请等待额度恢复或结束房间",
    RETRY_UNAVAILABLE: "当前无法重试 AI 回合",
    RETRY_DENIED: "当前不满足安全重试条件",
  };
  const errorText = (error) =>
    messages[error.message] || "请求暂未完成，请稍后同步";
  const executionText = (value) =>
    ({
      model_failed: "模型执行失败",
      delivery_failed: "任务投递失败",
      outcome_unknown: "结果未知，禁止再次执行",
      abandoned: "已停止，保留未确认记录",
      queued: "排队中",
      running: "思考中",
      succeeded: "已完成",
      failed: "执行失败",
      unknown: "结果待核对",
      blocked: "已阻断",
      idle: "等待行动",
      ready: "准备就绪",
      completed: "已完成",
      cancelled: "已取消",
    })[value] || "等待状态核对";
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
    timer = null,
    epoch = 0,
    polling = false;
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
  function waitingText() {
    return snapshot.owner
      ? snapshot.readyToStart
        ? "双方已就绪，点击开始对局。"
        : "你是房主，等待对方就绪后开始对局。"
      : "已加入，等待房主开始对局。";
  }
  function render() {
    $("join").disabled = busy;
    $("join").hidden = sessionEstablished;
    $("identity").textContent = sessionEstablished
      ? "已验证原 QQ 身份 · 本浏览器可操作自己的座位"
      : "尚未验证身份 · 请在你本人打开的网页完成 QQ 双端确认";
    if (!snapshot) return;
    $("game").hidden = false;
    $("join").hidden = true;
    const view = snapshot.view,
      board = view?.board || Array(225).fill(0);
    $("ai-status").textContent = snapshot.execution
      ? `AI 状态：${executionText(snapshot.execution.status)}${snapshot.execution.reason ? " · 暂不可继续，请核对后重试" : ""}`
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
          ? waitingText()
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
    $("resign-help").textContent =
      snapshot.lifecycle === "active" && !view?.canAct
        ? "当前是对方回合，暂不能认输；请等待对方完成。房主结束房间不计胜负。"
        : "自己的回合可认输；房主结束房间不计作对手获胜。";
    $("ai-retry").hidden = !snapshot.owner || !snapshot.execution?.retryable;
    $("ai-retry").disabled = !writable();
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
          start: "开始对局",
          pause: "暂停",
          resume: "恢复",
          close: "结束房间",
        }[type];
        if (type === "start") button.className = "primary";
        button.disabled =
          !writable() || (type === "start" && !snapshot.readyToStart);
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
  async function sync(background = false) {
    const started = epoch,
      current = () => !background || started === epoch;
    try {
      const next = await request("/view");
      if (!current()) return;
      if (snapshot && next.revision < snapshot.revision) return;
      if (snapshot?.revision !== next.revision) clearSelection();
      if (pending && pending.viewer !== next.viewer) forgetPending();
      if (failures && !pending) status("连接已恢复，已重新同步。");
      snapshot = next;

      // Poll only queries an uncertain action; replay requires an explicit retry with its original envelope.
      if (pending) {
        try {
          const receipt = await request(`/actions/${pending.request.actionId}`);
          if (!current()) return;
          if (receipt.revision > snapshot.revision) {
            const updated = await request("/view");
            if (!current()) return;
            if (updated.revision >= snapshot.revision) snapshot = updated;
          }
          forgetPending();
          clearSelection();
          status("操作已确认。");
        } catch (error) {
          if (!current()) return;
          if (error.message !== "ACTION_UNCONFIRMED") throw error;
        }
      }
      if (!current()) return;
      fresh = true;
      failures = 0;
      render();
    } catch (error) {
      if (!current()) return;
      clearSelection();
      fresh = false;
      failures = Math.min(5, failures + 1);
      throw error;
    }
  }
  async function exclusive(fn) {
    if (busy) return false;
    busy = true;
    epoch++;
    render();
    try {
      await fn();
    } catch (error) {
      status(
        `操作未确认：${errorText(error)}。当前棋局可能已过时，请查询原操作或等待同步。`,
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
        status(`操作已拒绝：${errorText(error)}。请重新选择。`);
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
      `确认游戏 ${roomId} ${binding.bindingId} ${binding.challenge}`;
    $("exchange").hidden = false;
    $("code-label").hidden = false;
    status(
      "只在私聊原角色时发送本人网页口令；群游戏也须私聊；若私聊无回应，请联系部署者检查私聊准入、暂停或静默设置。收到 QQ 回执后，在这里输入8位验证码再继续加入。",
    );
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
    $("code-label").hidden = true;
    try {
      await sync();
      status(
        snapshot.lifecycle === "waiting"
          ? waitingText()
          : "已加入，棋局已同步。",
      );
    } finally {
      schedule();
    }
  }
  async function exchange() {
    await request("/join", {
      bindingId: binding.bindingId,
      code: $("binding-code").value.trim(),
    });
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
          if (
            !["JOIN_UNCONFIRMED", "BINDING_CODE_INVALID"].includes(
              error.message,
            )
          )
            throw error;
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
  $("ai-retry").onclick = () =>
    exclusive(async () => {
      await request("/retry", {});
      await sync();
      status("已提交有限重试，请等待状态更新。");
    });
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
        if (!busy && !polling) {
          polling = true;
          const started = epoch;
          try {
            await sync(true);
          } catch (error) {
            if (started === epoch) {
              status(errorText(error));
              render();
            }
          } finally {
            polling = false;
          }
        }
        schedule();
      },
      Math.min(25000, 2500 * 2 ** failures) * (0.8 + Math.random() * 0.4),
    );
  }
  function wake() {
    clearSelection();
    fresh = false;
    render();
    if (sessionEstablished) {
      if (busy) schedule();
      else void exclusive(sync).finally(schedule);
    }
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
