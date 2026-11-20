/* global document, window */
import { element, button } from "./renderer-shared.js";

export function bindObservationResults(section, clock) {
  const scope = section.querySelector(".results-scope");
  const status = section.querySelector(".results-status");
  const replies = section.querySelector(".results-replies ul");
  const summaryLimit = section.querySelector(".results-summary-limit");
  const records = section.querySelector(".results-records");
  const recordsStatus = records.querySelector(".results-records-status");
  const list = records.querySelector("ul");
  const dateTime = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const invoke = (action, data) => window.nest.observationReview(action, data);
  const roleName = (agentId) =>
    room?.roles.find(({ id }) => id === agentId)?.name ?? agentId;
  const setStatus = (text) => {
    if (status.textContent !== text) status.textContent = text;
    status.hidden = !text;
  };
  let room;
  let session;
  let timer;
  let lastReplies = "";

  function renderReplies(entries) {
    const authors = entries.map(({ agentId, createdAt }) =>
      [roleName(agentId), Number.isFinite(createdAt) && clock.format(createdAt)]
        .filter(Boolean)
        .join(" · "),
    );
    const key = JSON.stringify([entries, authors]);
    if (lastReplies === key) return;
    lastReplies = key;
    const existing = new Map(
      [...replies.children].map((row) => [row.dataset.id, row]),
    );
    for (const [index, entry] of entries.entries()) {
      const id = String(entry.id);
      let row = existing.get(id);
      if (!row) {
        row = element("li");
        row.dataset.id = id;
        row.append(element("p", "results-meta"), element("p", "results-text"));
      }
      row.firstElementChild.textContent = authors[index];
      row.lastElementChild.textContent = entry.text;
      replies.append(row);
      existing.delete(id);
    }
    for (const row of existing.values()) row.remove();
  }

  async function refreshResults(current) {
    if (current.reading) {
      current.refreshQueued = true;
      return;
    }
    current.reading = true;
    try {
      const result = await invoke("status");
      if (session !== current) return;
      const entries =
        result?.replies ?? (result?.published ? [result.published] : []);
      renderReplies(entries);
      summaryLimit.hidden = !result?.summaryLimitReached;
      setStatus(
        result
          ? entries.length
            ? ""
            : "暂无观察回复。"
          : "当前无法读取观察回复。",
      );
      if (result && current.summaryVersion !== result.summaryVersion) {
        current.summaryVersion = result.summaryVersion;
        void refreshRecords(current);
      }
    } catch {
      if (session !== current) return;
      renderReplies([]);
      summaryLimit.hidden = true;
      setStatus("当前无法读取观察回复。");
    } finally {
      current.reading = false;
      if (session === current && current.refreshQueued) {
        current.refreshQueued = false;
        void refreshResults(current);
      }
    }
  }

  async function refreshRecords(current) {
    if (!records.open) return;
    const request = (current.recordRequest = Symbol());
    const currentRequest = () =>
      session === current && records.open && current.recordRequest === request;
    if (!list.childElementCount)
      recordsStatus.textContent = "正在读取观察摘要…";
    try {
      const result = await invoke("list");
      if (!currentRequest()) return;
      recordsStatus.textContent = result?.records.length
        ? ""
        : result
          ? "暂无已保存的摘要。"
          : "当前无法读取已保存的摘要。";
      list.replaceChildren();
      for (const {
        id,
        agentId,
        summary,
        createdAt,
        expiresAt,
      } of result?.records ?? []) {
        const row = element("li");
        const remove = button("secondary", "删除摘要");
        remove.addEventListener("click", async () => {
          if (session !== current || remove.disabled) return;
          remove.disabled = true;
          try {
            const result = await invoke("delete", { id, agentId });
            if (session !== current) return;
            if (result?.deleted) await refreshRecords(current);
            else {
              recordsStatus.textContent = "未能删除摘要。";
              remove.disabled = false;
            }
          } catch {
            if (session === current)
              recordsStatus.textContent = "未能删除摘要。";
            remove.disabled = false;
          }
        });
        row.append(
          element(
            "p",
            "results-meta",
            `${roleName(agentId)} · ${dateTime.format(createdAt)} 保存 · ${dateTime.format(expiresAt)} 到期`,
          ),
          element("p", "results-text", summary),
          remove,
        );
        list.append(row);
      }
    } catch {
      if (currentRequest())
        recordsStatus.textContent = "当前无法读取已保存的摘要。";
    }
  }

  function updateContext() {
    const active =
      !section.hidden &&
      !room?.desktopUnified &&
      room?.connected &&
      !document.hidden &&
      document.hasFocus();
    const grant = room?.observation;
    const context = [
      room?.roomEpoch,
      grant?.grantedAgentId,
      grant?.expiresAt,
      grant?.targetState,
      ...(grant?.displays ?? []).map(
        ({ grantId, targetState }) => `${grantId}:${targetState}`,
      ),
    ].join("/");
    if (session && (!active || session.context !== context)) {
      clearInterval(timer);
      session = undefined;
      renderReplies([]);
      list.replaceChildren();
      recordsStatus.textContent = "";
      summaryLimit.hidden = true;
      setStatus("");
    }
    if (!active) return;
    const revision = room.observationRevision;
    if (session) {
      if (session.revision === revision) return;
      session.revision = revision;
      clearInterval(timer);
    } else
      session = {
        context,
        revision,
        summaryVersion: null,
      };
    const current = session;
    void refreshResults(current);
    // Older hosts do not publish observation result revisions.
    if (revision === undefined)
      timer = setInterval(() => void refreshResults(current), 2000);
  }

  records.addEventListener("toggle", () => {
    if (session && records.open) void refreshRecords(session);
    else list.replaceChildren();
  });
  window.addEventListener("focus", updateContext);
  window.addEventListener("blur", updateContext);
  document.addEventListener("visibilitychange", updateContext);
  return (next) => {
    room = next;
    const grant = room?.observation;
    const description = grant?.grantedAgentId
      ? `${roleName(grant.grantedAgentId)} · ${grant.target ?? "授权窗口"} · 许可至 ${clock.format(grant.expiresAt)} · 剩余 ${grant.remaining} 次`
      : grant?.displays?.length
        ? `${grant.displays.length} 位角色已获显示器观察授权`
        : "可在小窝工具为在场角色授权观察。";
    if (scope.textContent !== description) scope.textContent = description;
    updateContext();
  };
}
