/* global Image, window, document, performance */
import { petPacks } from "./renderer-petpacks.js";

export function pickSmallAction(pack, previous, random = Math.random) {
  const all = Object.entries(pack.clips).filter(([, clip]) => clip.category);
  const choices =
    all.length > 1 ? all.filter(([name]) => name !== previous) : all;
  const weighted = choices.map(([name, clip]) => ({
    name,
    weight: ["日常起居", "娱乐休闲", "小动作"].includes(clip.category) ? 3 : 1,
  }));
  let ticket =
    random() * weighted.reduce((sum, entry) => sum + entry.weight, 0);
  return weighted.find(({ weight }) => (ticket -= weight) < 0)?.name;
}

export function bindPetPlayer(button, read) {
  const canvas = document.createElement("canvas");
  canvas.className = "pet-animation";
  canvas.width = 640;
  canvas.height = 360;
  canvas.hidden = true;
  button.append(canvas);
  const context = canvas.getContext("2d");
  let source,
    sheet,
    nextFrame,
    lastFrame,
    started,
    key,
    idleAt,
    idleName,
    previous,
    reported,
    visit;
  let rate = 1;
  const idleDelay = () => (12000 + Math.random() * 20000) / rate;
  function acknowledge(request, ok) {
    if (!request || request.token === reported) return;
    reported = request.token;
    window.nest.act("small-action-ended", { token: request.token, ok });
  }
  function tick(now = performance.now()) {
    const s = read();
    const pack = petPacks[s?.art];
    const active =
      !!pack && s.enabled && !document.hidden && s.motion !== "suspended";
    if (!active) {
      if (s?.request) acknowledge(s.request, false);
      canvas.hidden = true;
      delete button.dataset.petAnimation;
      idleAt = idleName = key = undefined;
      return;
    }
    if (visit !== s.visit) {
      visit = s.visit;
      idleAt = idleName = previous = undefined;
    }
    const idle =
      s.here &&
      s.activity === "idle" &&
      !s.busy &&
      !s.gesture &&
      !s.drag &&
      !s.request &&
      s.motion !== "moving" &&
      !s.reduce;
    const nextRate = s.idleRate ?? 1;
    if (rate !== nextRate) {
      // Preserve progress through this wait and leave any playing clip alone.
      if (idleAt !== undefined && !idleName)
        idleAt = now + (Math.max(0, idleAt - now) * rate) / nextRate;
      rate = nextRate;
    }
    if (!idle) idleAt = idleName = undefined;
    else {
      idleAt ??= now + idleDelay();
      if (!idleName && now >= idleAt) {
        idleName = pickSmallAction(pack, previous);
        previous = idleName;
      }
    }
    const gesture = s.gesture?.kind;
    const state = s.drag
      ? "drag"
      : s.motion === "moving"
        ? s.gait
        : gesture
          ? pack.states[gesture]
            ? gesture
            : "idle"
          : s.activity === "idle" && s.pose === "look"
            ? "look"
            : s.activity;
    const name =
      s.request?.name ?? idleName ?? pack.states[state] ?? pack.states.idle;
    const clip = pack.clips[name];
    if (!clip) return acknowledge(s.request, false);
    const url = "art/actions/" + s.art + "/" + clip.file + ".webp";
    const playback = [url, s.request?.token ?? s.gesture?.id, visit].join("|");
    if (source !== url) {
      source = url;
      sheet = new Image();
      sheet.src = url;
    }
    if (key !== playback || !sheet.complete) {
      key = playback;
      started = now;
      lastFrame = -1;
    }
    if (sheet.complete && sheet.naturalWidth) {
      const moving = s.motion === "moving" && !s.drag;
      const [first, last] = moving
        ? (clip.moving ?? [
            Math.floor(clip.frames / 3),
            Math.floor((clip.frames * 2) / 3),
          ])
        : [0, clip.frames - 1];
      const elapsed = now - started;
      const frames = last - first + 1;
      // A short touch shows the expressive middle of the original clip.
      const offset =
        gesture && !s.request && !moving ? Math.floor(clip.frames / 3) : 0;
      const step = offset + Math.floor((elapsed * clip.fps) / 1000);
      const once = s.request || idleName || gesture;
      const frame = s.reduce
        ? first
        : first + (once ? Math.min(step, frames - 1) : step % frames);
      canvas.hidden = false;
      button.dataset.petAnimation =
        s.request || idleName ? "small-action" : state;
      if (frame !== lastFrame) {
        lastFrame = frame;
        const { width, height } = canvas;
        context.clearRect(0, 0, width, height);
        context.drawImage(
          sheet,
          (frame % 8) * width,
          Math.floor(frame / 8) * height,
          width,
          height,
          0,
          0,
          width,
          height,
        );
      }
      if (elapsed >= (clip.frames * 1000) / clip.fps) {
        if (s.request) acknowledge(s.request, true);
        if (idleName) {
          idleName = undefined;
          idleAt = now + idleDelay();
        }
      }
    } else if (sheet.complete) acknowledge(s.request, false);
    if (!s.reduce || s.request || !sheet.complete)
      nextFrame = window.setTimeout(() => {
        nextFrame = undefined;
        tick();
      }, 1000 / 24);
  }
  function refresh() {
    window.clearTimeout(nextFrame);
    tick();
  }
  return refresh;
}
