let visitsView,
  visitsGeneration = 0;
function closeVisits() {
  visitsGeneration++;
  visitsView?.close();
  visitsView = null;
}
async function renderVisits(content) {
  closeVisits();
  const generation = visitsGeneration,
    agentId = roleId;
  content.innerHTML =
    '<section class="card"><p class="hint">本人作客与接待时留下的信件。</p><div id="visits-records" aria-live="polite">读取访问记录…</div></section>';
  const root = content.querySelector("#visits-records");
  if (!agentId) {
    root.textContent = "还没有角色。";
    return;
  }
  const isActive = () =>
    generation === visitsGeneration && tab === "visits" && roleId === agentId;
  try {
    const { createSocialView } = await import("./home-space/social.mjs");
    if (!isActive()) return;
    visitsView = createSocialView({
      root,
      api,
      isActive,
      agentId,
      presentation: "letters",
    });
    await visitsView.render();
  } catch {
    if (isActive()) root.textContent = "访问记录暂时无法读取，请重新打开此页。";
  }
}
globalThis.addEventListener?.("pagehide", closeVisits);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) closeVisits();
  else if (tab === "visits" && roleId)
    return action(() => renderVisits($("#content")));
});
