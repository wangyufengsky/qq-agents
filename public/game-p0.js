(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const join = $("join");
  if (join)
    join.onsubmit = async (event) => {
      event.preventDefault();
      const button = join.querySelector("button");
      button.disabled = true;
      try {
        // WebKit sends Origin: null for non-CORS requests under no-referrer.
        // CORS mode preserves Origin; the target and credentials stay same-origin.
        const response = await fetch(join.action, {
          method: "POST",
          mode: "cors",
          credentials: "same-origin",
          body: new URLSearchParams(new FormData(join)),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw Error("JOIN_FAILED");
        location.replace(response.url);
      } catch {
        $("copy-result").textContent =
          "加入未确认，请刷新原链接重试。若会话异常，请用系统浏览器打开独立邀请。";
        button.disabled = false;
      }
    };
  $("copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("copy-result").textContent = "已复制；换浏览器时可能需要新的测试邀请。";
    } catch {
      $("copy-result").textContent = "请使用浏览器菜单复制地址。";
    }
  };
  const room = $("room");
  if (!room) return;
  const base = `/room/${room.dataset.room}`;
  const key = `qq-game-p0:${room.dataset.room}`;
  let revision = Number(room.dataset.revision);
  let board = [],
    selected = null,
    pending = null,
    busy = false,
    syncing = false,
    failures = 0,
    timer;
  let storageReady = true;
  try {
    pending = JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(`${key}:check`, "1");
    localStorage.removeItem(`${key}:check`);
  } catch {
    storageReady = false;
  }
  function controls() {
    $("confirm").disabled =
      !storageReady || busy || syncing || !!pending || selected === null;
    $("cancel").disabled = selected === null || busy;
    $("retry").hidden = !pending;
    $("retry").disabled = busy || syncing;
    for (const cell of $("board").children)
      cell.disabled =
        !storageReady ||
        busy ||
        !!pending ||
        !!board[Number(cell.dataset.index)];
  }
  function clearSelection() {
    selected = null;
    $("selection").textContent = "先点选位置，再确认提交。";
    $("zoom").replaceChildren();
    for (const cell of $("board").children) cell.classList.remove("selected");
    controls();
  }
  function select(index) {
    if (busy || pending || board[index] || !storageReady) return;
    selected = index;
    const x = index % 15,
      y = Math.floor(index / 15);
    $("selection").textContent =
      `待确认：${String.fromCharCode(65 + x)}${y + 1}。下方为局部放大，可重新选点。`;
    for (const cell of $("board").children)
      cell.classList.toggle("selected", Number(cell.dataset.index) === index);
    $("zoom").replaceChildren();
    const startX = Math.max(0, Math.min(12, x - 1)),
      startY = Math.max(0, Math.min(12, y - 1));
    for (let row = startY; row < startY + 3; row++)
      for (let col = startX; col < startX + 3; col++) {
        const i = row * 15 + col,
          button = document.createElement("button");
        button.textContent = `${String.fromCharCode(65 + col)}${row + 1}${board[i] ? (board[i] === 1 ? "●" : "○") : ""}`;
        button.disabled = !!board[i];
        button.classList.toggle("selected", i === index);
        button.onclick = () => select(i);
        $("zoom").append(button);
      }
    controls();
  }
  for (const cell of $("board").children)
    cell.onclick = () => select(Number(cell.dataset.index));
  $("cancel").onclick = clearSelection;
  async function request(route, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${base}/${route}`, {
        method: payload ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        ...(payload
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }
          : {}),
      });
      const data = await response.json();
      if (!response.ok)
        throw Object.assign(Error(data.error || "REQUEST_FAILED"), {
          status: response.status,
        });
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
  function forgetPending() {
    localStorage.removeItem(key);
    pending = null;
  }
  function render(state) {
    if (state.revision !== revision) clearSelection();
    revision = state.revision;
    board = state.board;
    $("revision").textContent = revision;
    for (const cell of $("board").children) {
      const i = Number(cell.dataset.index),
        stone = board[i];
      cell.textContent = stone ? (stone === 1 ? "●" : "○") : "·";
      cell.className = `cell stone-${stone}${selected === i ? " selected" : ""}`;
      cell.setAttribute(
        "aria-label",
        `${String.fromCharCode(65 + (i % 15))}${Math.floor(i / 15) + 1}${stone ? (stone === 1 ? " 黑子" : " 白子") : " 空位"}`,
      );
    }
    $("connection").textContent = !storageReady
      ? "浏览器无法保存待确认操作，已禁用提交。请用系统浏览器打开另一条测试邀请。"
      : pending
        ? "结果待确认；正在查询原操作，请勿重复落点。"
        : `已同步 · ${new Date(state.snapshotAt).toLocaleTimeString()}`;
    controls();
  }
  async function reconcile() {
    if (!pending) return;
    try {
      await request(`receipt/${pending.actionId}`);
      forgetPending();
      clearSelection();
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  async function sync() {
    if (syncing || busy || document.hidden) return;
    syncing = true;
    controls();
    clearTimeout(timer);
    try {
      await reconcile();
      render(await request("state"));
      failures = 0;
    } catch (error) {
      failures++;
      $("connection").textContent =
        error.status === 401 || error.status === 410
          ? "会话失效或房间已过期，请联系部署者。"
          : "连接中断，当前为旧快照。恢复后自动查询；临时地址失效请联系部署者。";
    } finally {
      syncing = false;
      controls();
      timer = setTimeout(
        sync,
        Math.min(30000, 2500 * 2 ** Math.min(failures, 4)) *
          (0.8 + Math.random() * 0.4),
      );
    }
  }
  async function submit() {
    if (busy || syncing || !storageReady || (!pending && selected === null))
      return;
    if (!pending) {
      const action = {
        actionId: crypto.randomUUID(),
        expectedRevision: revision,
        x: selected % 15,
        y: Math.floor(selected / 15),
      };
      try {
        localStorage.setItem(key, JSON.stringify(action));
        pending = action;
      } catch {
        storageReady = false;
        $("connection").textContent =
          "无法保存待确认操作，未发送。请换浏览器。";
        controls();
        return;
      }
    }
    busy = true;
    controls();
    $("connection").textContent = "正在提交／查询原操作…";
    try {
      await reconcile();
      if (pending) {
        await request("actions", pending);
        forgetPending();
      }
      clearSelection();
    } catch (error) {
      if (error.status === 409 || error.status === 400) {
        forgetPending();
        clearSelection();
        $("selection").textContent =
          `操作被拒绝（${error.message}），请刷新后重新选点。`;
      } else
        $("connection").textContent =
          "结果待确认。请查询原操作；刷新后仍会保留此次请求。";
    } finally {
      busy = false;
      controls();
      void sync();
    }
  }
  $("confirm").onclick = submit;
  $("retry").onclick = submit;
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    clearSelection();
    if (!document.hidden) void sync();
  });
  window.addEventListener("orientationchange", clearSelection);
  window.addEventListener("pageshow", () => {
    clearSelection();
    void sync();
  });
  controls();
  void sync();
})();
