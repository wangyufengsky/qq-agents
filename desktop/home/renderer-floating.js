/* global document, window */
import { bindPetPlayer } from "./renderer-pet.js";
import { bindBubbleComposer } from "./renderer-bubbles.js";
import {
  element,
  image,
  button,
  activityLabels,
  bodyPoseLabels,
  bodyGestureLabels,
  activityFor,
} from "./renderer-shared.js";

function bindFloatingDrag(handle, door) {
  let pointer;
  let moved = false;
  const point = (event) => ({ x: event.screenX, y: event.screenY });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointer) return;
    const origin = point(event);
    pointer = { id: event.pointerId, origin, last: origin };
    moved = false;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (pointer?.id !== event.pointerId) return;
    const last = (pointer.last = point(event));
    if (
      !moved &&
      Math.hypot(last.x - pointer.origin.x, last.y - pointer.origin.y) >= 5
    ) {
      moved = true;
      if (!handle.hasAttribute("data-unified-drag")) {
        handle.dataset.dragging = "true";
        delete handle.dataset.motionTransition;
        delete handle.dataset.gesture;
      }
      window.nest.act("drag-start", pointer.origin);
    }
    if (moved) window.nest.act("drag-move", last);
  });
  function endDrag(event) {
    if (pointer?.id !== event.pointerId) return;
    if (moved)
      window.nest.act(
        "drag-end",
        event.type === "pointerup" ? point(event) : pointer.last,
      );
    pointer = undefined;
    delete handle.dataset.dragging;
  }
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
    handle.addEventListener(event, endDrag);
  handle.addEventListener("click", (event) => {
    if (event.detail === 0) window.nest.act("open");
    else if (!moved) window.nest.act(door ? "open" : "pet");
    moved = false;
  });
}

export function floating(root, type, id) {
  const space = element("main", "floating");
  const door = type === "door";
  const art = button(
    door ? "door-button" : "sprite-button",
    "",
    door ? "打开小窝的门" : "打开小窝聊天",
  );
  let refreshPet;
  let pageVisible;
  function syncVisibility() {
    const visible = !document.hidden;
    if (pageVisible === visible) return;
    pageVisible = visible;
    art.toggleAttribute("data-page-hidden", !visible);
    if (!visible) {
      delete art.dataset.motionTransition;
      delete art.dataset.gesture;
    }
    refreshPet?.();
    window.nest.act("page-visible", visible);
  }
  window.addEventListener("load", syncVisibility, { once: true });
  document.addEventListener("visibilitychange", syncVisibility);
  art.title = door
    ? "点击打开小窝 · 拖动换位置"
    : "点击摸头 · 拖动换座位 · 右键打开聊天";
  const sprite = image(door ? "door" : undefined);
  const walkFrames = [];
  let gestureLayer;
  if (door) art.append(sprite);
  else {
    let receivedSize = false;
    const size = (value) =>
      art.style.setProperty("--sprite-scale", String(value / 100));
    window.nest.onSpriteSize?.((value) => {
      receivedSize = true;
      size(value);
    });
    window.nest.getSpriteSize?.().then((value) => {
      if (!receivedSize) size(value);
    });
    const body = element("span", "sprite-body");
    gestureLayer = element("span", "sprite-gesture");
    const pose = element("span", "sprite-pose");
    const cue = element("span", "sprite-cue");
    const walk = element("span", "sprite-walk");
    walkFrames.push(image(), image());
    cue.setAttribute("aria-hidden", "true");
    walk.setAttribute("aria-hidden", "true");
    walk.append(...walkFrames);
    sprite.className = "sprite-rest";
    body.addEventListener("animationend", (event) => {
      if (event.target === body) delete art.dataset.motionTransition;
    });
    gestureLayer.addEventListener("animationend", (event) => {
      if (event.target === gestureLayer) delete art.dataset.gesture;
    });
    pose.append(sprite, walk, cue);
    const petFace = element("span", "sprite-pet-face");
    const petHand = element("span", "sprite-petting");
    petFace.setAttribute("aria-hidden", "true");
    petHand.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 2; i++) {
      const eye = element("span", "pet-eye");
      eye.append(element("span", "pet-lid"));
      petFace.append(eye);
    }
    petHand.append(element("span", "pet-palm"));
    gestureLayer.append(pose, petFace);
    body.append(gestureLayer, petHand);
    art.append(body);
  }
  space.append(art);
  root.append(space);
  bindFloatingDrag(art, door);

  function subscribe(update) {
    const receive = (data) => {
      art.toggleAttribute(
        "data-unified-drag",
        !door && data.desktopUnified === true,
      );
      update(data);
    };
    window.nest.onRoom(receive);
    window.nest.get().then((value) => {
      if (value) receive(value.data);
    });
  }

  if (door) {
    const indicator = element("span", "door-knock", "有人敲门");
    indicator.hidden = true;
    art.append(indicator);
    subscribe((data) => {
      const visitor = data.roles.find(({ id }) => id === data.knock?.actor);
      indicator.hidden = !visitor;
      art.setAttribute(
        "aria-label",
        visitor ? `${visitor.name}敲门，打开小窝的门` : "打开小窝的门",
      );
    });
    return;
  }

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const syncMotion = () => {
    if (motion.matches) delete art.dataset.motionTransition;
    delete art.dataset.gesture;
    refreshPet?.();
    window.nest.act("motion-preference", motion.matches);
  };
  syncMotion();
  motion.addEventListener("change", syncMotion);
  let role;
  let room;
  let gait = "walk";
  let ownerDragging = false;
  window.nest.onGait?.((value) => {
    gait = value;
    refreshPet?.();
  });
  window.nest.onOwnerDrag?.((value) => {
    ownerDragging = value;
    refreshPet?.();
  });
  refreshPet = bindPetPlayer(
    art,
    () =>
      role && {
        enabled: room.smallActions,
        here: role.state === "here" && !room.connectionLost,
        visit: role.bodyVisitId,
        art: role.art ?? role.id,
        pose: role.bodyStatus?.pose,
        gesture: role.bodyStatus?.gesture,
        request: role.bodyStatus?.smallAction,
        busy:
          room.thinking === id ||
          Boolean(room.bubbles?.[id]) ||
          role.bodyStatus?.state === "paused",
        activity: activityFor(role, room),
        drag: ownerDragging || !!art.dataset.dragging,
        gait,
        motion: art.dataset.motion,
        reduce: motion.matches,
      },
  );
  let lastGestureId;
  window.nest.onMotion?.((state) => {
    const previous = art.dataset.motion;
    if (previous === state) return;
    art.dataset.motion = state;
    if (state !== "moving") art.style.removeProperty("--travel-rate");
    if (state === "suspended") delete art.dataset.gesture;
    delete art.dataset.motionTransition;
    if (!motion.matches && pageVisible && !art.dataset.dragging) {
      if (state === "moving") art.dataset.motionTransition = "start";
      if (previous === "moving" && state === "still")
        art.dataset.motionTransition = "stop";
    }
    if (role) renderSprite();
    refreshPet?.();
  });
  window.nest.onMotionSpeed?.((speed) => {
    if (art.dataset.motion !== "moving" || speed <= 0) return;
    // Keep slow steps legible and cap the cadence of very short, fast moves.
    const rate =
      speed < 300
        ? 1 + 0.4 * (1 - Math.max(speed, 80) / 300)
        : 1 - 0.32 * Math.min(1, (speed - 300) / 450);
    art.style.setProperty("--travel-rate", rate);
  });
  function face(facing) {
    if (art.dataset.facing !== facing) art.dataset.facing = facing;
  }
  window.nest.onFacing?.(face);
  const speech = button("speech", "", "打开小窝聊天");
  const words = element("span");
  speech.append(words);
  speech.hidden = true;
  const bubbleComposer = bindBubbleComposer(space, true);
  speech.addEventListener("click", () => {
    const bubbleId = room?.bubbles?.[id]?.bubbleId;
    if (
      bubbleId &&
      room?.recentBubbles?.some(
        (bubble) => bubble.bubbleId === bubbleId && bubble.canReply,
      )
    ) {
      void bubbleComposer.open(bubbleId, room);
    } else window.nest.act("open");
  });
  const bubbleCollaboration = button(
    "bubble-collaboration",
    "协作",
    "查看当前协作内容",
  );
  bubbleCollaboration.hidden = true;
  bubbleCollaboration.addEventListener("click", () => {
    const card = role?.statusCard;
    if (!card || !room?.roomEpoch || !role.bodyVisitId) return;
    void window.nest.openStatusCard?.({
      roomEpoch: room.roomEpoch,
      visitId: role.bodyVisitId,
      ref: card.ref,
    });
  });
  space.prepend(bubbleCollaboration);
  const statusCard = button("status-card", "", "打开状态卡");
  statusCard.hidden = true;
  statusCard.addEventListener("click", () => {
    const card = role?.statusCard;
    if (!card || !room?.roomEpoch || !role.bodyVisitId) return;
    void window.nest.openStatusCard?.({
      roomEpoch: room.roomEpoch,
      visitId: role.bodyVisitId,
      ref: card.ref,
    });
  });
  space.prepend(statusCard);
  space.prepend(speech);
  art.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    window.nest.act("menu");
  });

  function renderSprite() {
    const moving = art.dataset.motion === "moving";
    const roomActivity = activityFor(role, room);
    const activity = moving
      ? "move"
      : roomActivity === "move"
        ? "idle"
        : roomActivity;
    const pose = role.bodyStatus?.pose ?? art.dataset.pose ?? "sit";
    const roleArt = role.art ?? role.id;
    if (art.dataset.pose !== pose) art.dataset.pose = pose;
    if (art.dataset.appearance !== roleArt) {
      art.dataset.appearance = roleArt;
      walkFrames[0].src = `art/actions/${roleArt}-stride.webp`;
      walkFrames[1].src = `art/actions/${roleArt}-step.webp`;
    }
    if (art.dataset.activity !== activity) art.dataset.activity = activity;
    const gesture = role.bodyStatus?.gesture;
    const gestureLabel = bodyGestureLabels[gesture?.kind] ?? "";
    if (art.dataset.gestureLabel !== gestureLabel)
      art.dataset.gestureLabel = gestureLabel;
    const label = [
      role.name,
      activityLabels[activity],
      bodyPoseLabels[moving ? "stand" : pose],
      gestureLabel,
      "点击摸头，按回车打开聊天",
    ]
      .filter(Boolean)
      .join(" · ");
    if (art.getAttribute("aria-label") !== label)
      art.setAttribute("aria-label", label);
    const stance =
      moving || (activity === "idle" && pose !== "sit") ? "stand" : activity;
    const asset = `art/actions/${roleArt}-${stance}.webp`;
    if (sprite.getAttribute("src") !== asset) sprite.src = asset;
  }

  function renderGesture(gesture) {
    if (
      gesture?.id === undefined ||
      !Object.hasOwn(bodyGestureLabels, gesture.kind) ||
      room.connectionLost
    ) {
      delete art.dataset.gesture;
      return;
    }
    if (gesture.id === lastGestureId) return;
    lastGestureId = gesture.id;
    if (
      !pageVisible ||
      art.dataset.dragging ||
      art.dataset.motion === "suspended"
    )
      return;
    if (art.dataset.gesture === gesture.kind) {
      // Flush the previous one-shot animation before replaying the same kind.
      delete art.dataset.gesture;
      gestureLayer.getBoundingClientRect();
    }
    art.dataset.gesture = gesture.kind;
  }

  subscribe((data) => {
    room = data;
    bubbleComposer.update(room);
    role = data.roles.find((item) => item.id === id);
    refreshPet();
    if (!role) {
      delete art.dataset.gesture;
      statusCard.hidden = true;
      bubbleCollaboration.hidden = true;
      statusCard.textContent = "";
      return;
    }
    const facing = role.bodyStatus?.facing;
    if (facing) face(facing);
    renderSprite();
    const card = role.statusCard;
    statusCard.hidden =
      !card ||
      role.state !== "here" ||
      !role.bodyVisitId ||
      !room.roomEpoch ||
      room.connectionLost ||
      typeof card.title !== "string" ||
      !card.ref;
    statusCard.textContent = statusCard.hidden ? "" : card.title;
    statusCard.setAttribute(
      "aria-label",
      `打开状态卡：${statusCard.textContent}`,
    );
    renderGesture(role.bodyStatus?.gesture);
    const bubble = data.bubbles?.[id];
    bubbleCollaboration.hidden =
      !bubble?.bubbleId ||
      !data.recentBubbles?.some(
        (item) => item.bubbleId === bubble.bubbleId && item.actor === id,
      ) ||
      role.state !== "here" ||
      !role.bodyVisitId ||
      !data.roomEpoch ||
      data.connectionLost ||
      !["shared-draft", "work-note"].includes(card?.kind) ||
      !card.ref ||
      !window.nest.openStatusCard;
    space.toggleAttribute(
      "data-bubble-collaboration",
      !bubbleCollaboration.hidden,
    );
    const message = bubble?.text ?? (data.thinking === id ? "正在想…" : "");
    speech.setAttribute(
      "aria-label",
      bubble?.bubbleId ? "回复公开气泡" : "打开小窝聊天",
    );
    words.textContent = message;
    speech.hidden = !message;
  });
}
