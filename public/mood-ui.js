// Mood: the agent's own account of how it feels. Read-only here; only the
// agent changes it. Mood and reason are untrusted text: esc() in markup,
// textContent in the chart and tooltip.
let moodRangeDays = 7;
const MOOD_MINUTE = 60000,
  MOOD_HOUR = 3600000,
  MOOD_DAY = 86400000;
const moodSpan = (ms) => {
  const minutes = Math.max(1, Math.round(ms / MOOD_MINUTE));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
};
const moodClock = (t) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const moodDay = (t) =>
  new Date(t).toLocaleDateString([], { month: "numeric", day: "numeric" });
const moodWhen = (t) => `${moodDay(t)} ${moodClock(t)}`;
function moodWhere(where) {
  if (!where) return "";
  if (where === "@subject") return "空闲时间";
  const [kind, id] = where.split(":");
  return kind === "group" ? `群 ${id}` : kind === "private" ? `私聊 ${id}` : "";
}
const moodDots = (n) =>
  `<span class="mood-dots" role="img" aria-label="强度 ${n}/5">${[1, 2, 3, 4, 5].map((i) => `<i${i <= n ? ' class="on"' : ""}></i>`).join("")}</span>`;
// The people a mood is about. One with a card opens it (people-ui.js);
// labels are untrusted text.
function moodPeople(people) {
  if (!people?.length) return "";
  return `<div class="mood-people"><span>相关的人</span>${people
    .map((p) => {
      const label = esc(p.call || p.name || `QQ ${p.personId}`);
      return p.card
        ? `<button type="button" class="mood-person" data-mood-person="${esc(p.personId)}" title="打开 QQ ${esc(p.personId)} 的人物卡">${label}</button>`
        : `<span class="mood-person" title="QQ ${esc(p.personId)}，还没有人物卡">${label}</span>`;
    })
    .join("")}</div>`;
}
// A mood lasts until it expires, the next change, or now.
// Diaries written while a mood was in effect; a title opens the diary.
function moodDiaries(diaries) {
  if (!diaries?.length) return "";
  return `<div class="mood-people"><span>当时写的日记</span>${diaries.map((d) => `<button type="button" class="mood-person" data-read-diary="${esc(d.id)}" title="阅读这篇日记">${esc(d.title)}</button>`).join("")}</div>`;
}
function moodSegments(history, now) {
  const ordered = [...history].reverse();
  return ordered.flatMap((x, i) => {
    if (x.action !== "set") return [];
    const end = Math.min(
      x.expiresAt,
      ordered[i + 1]?.writtenAt ?? Infinity,
      now,
    );
    return end > x.since ? [{ ...x, start: x.since, end }] : [];
  });
}
function moodNowMarkup(mood, now) {
  const { current, history } = mood;
  if (!current) {
    const last = history[0];
    const after = !last
      ? "角色还没有记录过心情。"
      : last.action === "clear"
        ? `${moodWhen(last.writtenAt)} 记下心情已经过去：${esc(last.reason)}`
        : `上一次是「${esc(last.mood)}」，已于 ${moodWhen(last.expiresAt)} 到期。`;
    return `<div class="mood-now is-calm"><span class="mood-label">此刻的心情</span><div class="mood-value">平常</div><p class="mood-note">${after}</p></div>`;
  }
  const at = history.findIndex((x) => x.id === current.id),
    before = at >= 0 ? history[at + 1] : undefined;
  const total = current.expiresAt - current.since,
    left = Math.max(0, current.expiresAt - now),
    spent = Math.min(1, Math.max(0, 1 - left / total));
  const where = moodWhere(current.writtenIn);
  return `<div class="mood-now"><div class="mood-head"><span class="mood-label">此刻的心情</span>${where ? `<span class="mood-chip">写在${esc(where)}</span>` : ""}</div><div class="mood-value">${esc(current.mood)}</div><div class="mood-strength">${moodDots(current.intensity)}<span>强度 ${current.intensity}/5</span></div><blockquote class="mood-reason">${esc(current.reason)}</blockquote>${moodPeople(history[at]?.people)}${moodDiaries(history[at]?.diaries)}<div class="mood-life"><svg class="mood-life-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="4" rx="2"/><rect class="bar" width="${(1 - spent) * 100}" height="4" rx="2"/></svg><span>还剩 ${moodSpan(left)} · 到 ${moodWhen(current.expiresAt)}</span></div>${before ? `<p class="mood-from">由${before.action === "clear" ? "平常" : `「${esc(before.mood)}」（${before.intensity}/5）`}变来 · ${moodWhen(current.since)}</p>` : ""}</div>`;
}
function moodLogMarkup(history, currentId, now) {
  if (!history.length) return "";
  const rows = history.map((x, i) => {
    const where = moodWhere(x.writtenIn),
      next = history[i - 1],
      lasted =
        x.action !== "set"
          ? ""
          : x.id === currentId
            ? `已持续 ${moodSpan(now - x.since)}`
            : `持续 ${moodSpan(Math.min(x.expiresAt, next?.writtenAt ?? x.expiresAt) - x.since)}`;
    return `<li class="${x.action === "clear" ? "is-clear" : ""}${x.id === currentId ? " is-current" : ""}${i >= 8 ? " is-extra" : ""}"><span class="mood-dot" aria-hidden="true"></span><div class="mood-entry"><div class="mood-entry-head">${x.action === "clear" ? "<strong>心情过去了</strong>" : `<strong>${esc(x.mood)}</strong>${moodDots(x.intensity)}`}<time>${moodWhen(x.writtenAt)}</time></div><p>${esc(x.reason)}</p>${moodPeople(x.people)}${moodDiaries(x.diaries)}<small>${[where && `写在${esc(where)}`, lasted, x.evidence?.length ? `<span title="${esc(x.evidence.join("\n"))}">来源 ${x.evidence.length} 条记录</span>` : ""].filter(Boolean).join(" · ")}</small></div></li>`;
  });
  return `<div class="mood-section-title"><h3>变化记录</h3><span class="hint">最近 ${history.length} 次，最新在上</span></div><ol class="mood-log" id="mood-log">${rows.join("")}</ol>${history.length > 8 ? `<button type="button" class="ghost mood-more" id="mood-more">显示全部 ${history.length} 次</button>` : ""}`;
}
function moodMarkup(mood, now) {
  return `<section class="card mood-card"><h2>心情</h2><p class="hint">角色自己记下的心情和原因；有效期内同一会话只附上一次，心情变了再附。这里只能查看，心情只有角色自己能改，想让角色心情好起来，就去和角色聊天。</p>${moodNowMarkup(mood, now)}<div class="mood-section-title"><h3>强度变化</h3><div class="mood-range" role="group" aria-label="时间范围"><button type="button" data-mood-range="1">24 小时</button><button type="button" data-mood-range="7">7 天</button></div></div><div class="mood-chart" id="mood-chart"></div>${moodLogMarkup(mood.history, mood.current?.id, now)}</section>`;
}
function drawMoodChart(mood, now) {
  const host = $("#mood-chart");
  if (!host) return;
  host.replaceChildren();
  const from = now - moodRangeDays * MOOD_DAY,
    x = (t) => ((Math.max(t, from) - from) / (now - from)) * 100;
  const segments = moodSegments(mood.history, now).filter((s) => s.end > from),
    clears = mood.history.filter(
      (h) => h.action === "clear" && h.writtenAt > from,
    );
  document.querySelectorAll("[data-mood-range]").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.moodRange) === moodRangeDays);
    b.setAttribute(
      "aria-pressed",
      String(Number(b.dataset.moodRange) === moodRangeDays),
    );
  });
  if (!segments.length && !clears.length) {
    const empty = document.createElement("p");
    empty.className = "hint mood-empty";
    empty.textContent =
      moodRangeDays === 1
        ? "最近 24 小时没有记录心情。"
        : "最近 7 天没有记录心情。";
    host.append(empty);
    return;
  }
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  const plot = el("div", "mood-plot");
  for (const level of [1, 2, 3, 4, 5]) {
    const line = el("span", "mood-grid");
    line.style.bottom = `${(level / 5) * 100}%`;
    const label = el("span", "mood-ylabel");
    label.textContent = String(level);
    label.style.bottom = `${(level / 5) * 100}%`;
    plot.append(line, label);
  }
  const tip = el("div", "mood-tip");
  tip.hidden = true;
  const show = (segment, target) => {
    tip.replaceChildren();
    const head = el("strong");
    head.textContent = `${segment.mood} · ${segment.intensity}/5`;
    const span = el("span");
    span.textContent = `${moodWhen(segment.start)} – ${moodClock(segment.end)}（${moodSpan(segment.end - segment.start)}）`;
    const why = el("span", "why");
    why.textContent = segment.reason;
    tip.append(head, span, why);
    const where = moodWhere(segment.writtenIn);
    if (where) {
      const at = el("span");
      at.textContent = `写在${where}`;
      tip.append(at);
    }
    tip.hidden = false;
    const box = plot.getBoundingClientRect(),
      mark = target.getBoundingClientRect(),
      left = mark.left - box.left + mark.width / 2;
    tip.style.left = `${Math.min(Math.max(left, 90), box.width - 90)}px`;
  };
  for (const s of segments) {
    const bar = el(
      "button",
      `mood-bar${s.id === mood.current?.id ? " is-current" : ""}`,
    );
    bar.type = "button";
    bar.style.left = `${x(s.start)}%`;
    bar.style.width = `${Math.max(x(s.end) - x(s.start), 0.6)}%`;
    bar.style.height = `${(s.intensity / 5) * 100}%`;
    bar.setAttribute(
      "aria-label",
      `${s.mood}，强度 ${s.intensity}/5，${moodWhen(s.start)} 起持续 ${moodSpan(s.end - s.start)}`,
    );
    bar.addEventListener("pointerenter", () => show(s, bar));
    bar.addEventListener("focus", () => show(s, bar));
    bar.addEventListener("pointerleave", () => (tip.hidden = true));
    bar.addEventListener("blur", () => (tip.hidden = true));
    plot.append(bar);
  }
  for (const c of clears) {
    const mark = el("span", "mood-clear");
    mark.style.left = `${x(c.writtenAt)}%`;
    mark.title = `${moodWhen(c.writtenAt)} 心情过去了`;
    plot.append(mark);
  }
  plot.append(el("span", "mood-now-line"), tip);
  const axis = el("div", "mood-axis");
  const step = moodRangeDays === 1 ? 6 * MOOD_HOUR : MOOD_DAY,
    first = new Date(from);
  if (moodRangeDays === 1)
    first.setHours(Math.ceil(first.getHours() / 6) * 6, 0, 0, 0);
  else first.setHours(24, 0, 0, 0);
  // Keep ticks about 44px apart and clear of the "现在" label on the right.
  const width = Math.max(1, host.clientWidth - 22),
    every = Math.max(1, Math.ceil(44 / ((step / (now - from)) * width)));
  for (let t = +first; ((100 - x(t)) / 100) * width > 40; t += step * every) {
    const tick = el("span");
    tick.textContent = moodRangeDays === 1 ? moodClock(t) : moodDay(t);
    tick.style.left = `${x(t)}%`;
    axis.append(tick);
  }
  const nowLabel = el("span", "mood-axis-now");
  nowLabel.textContent = "现在";
  axis.append(nowLabel);
  host.append(plot, axis);
}
function bindMood(mood, now, agentId) {
  document.querySelectorAll("[data-mood-range]").forEach(
    (b) =>
      (b.onclick = () => {
        moodRangeDays = Number(b.dataset.moodRange);
        drawMoodChart(mood, now);
      }),
  );
  drawMoodChart(mood, now);
  document
    .querySelectorAll("[data-mood-person]")
    .forEach(
      (b) => (b.onclick = () => openPersonCard(agentId, b.dataset.moodPerson)),
    );
  document
    .querySelectorAll(".mood-card [data-read-diary]")
    .forEach(
      (b) => (b.onclick = () => readMemory(b.dataset.readDiary, { agentId })),
    );
  const more = $("#mood-more");
  if (more)
    more.onclick = () => {
      $("#mood-log").classList.add("show-all");
      more.remove();
    };
}
