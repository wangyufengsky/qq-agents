export const MAX_TURNS = 6;
export const DEFAULT_MINUTES = 60;
const MINUTE = 60_000;

export const roles = [
  {
    id: "fish",
    name: "小鱼",
    color: "teal",
    title: "大肥鱼",
    tone: [
      "我在这儿，慢慢说。",
      "我觉得可以先挑个最顺手的小点试试。",
      "那我先在这儿陪一会儿。",
    ],
  },
  {
    id: "dragon",
    name: "龙",
    color: "green",
    title: "大肥龙",
    tone: [
      "我来了，先听听大家怎么想。",
      "我接一句，我们可以把眼下这件事拆小一点。",
      "等你想聊了，我们再接着说。",
    ],
  },
  {
    id: "cat",
    name: "猫",
    color: "peach",
    title: "哈基米",
    tone: [
      "我听见了，挪个位置给我。",
      "我补一句，先给自己留点喘气的空当吧。",
      "好，那我就蜷在这里坐会儿。",
    ],
  },
];

export function createRoom(
  minutes = DEFAULT_MINUTES,
  now = Date.now(),
  roster = roles,
  maxTurns = MAX_TURNS,
) {
  return {
    roles: roster,
    maxTurns,
    members: Object.fromEntries(roster.map(({ id }) => [id, "home"])),
    messages: [],
    budget: maxTurns,
    minutes,
    nextRefill: minutes ? now + minutes * MINUTE : null,
    turn: null,
    waiting: [],
    sequence: 0,
    starter: 0,
    bubbles: {},
    notice: "门开着，想见谁就邀请谁。",
  };
}

export function addMessage(
  room,
  actor,
  text,
  now = Date.now(),
  attachments = [],
  turnId,
  speakerType = "system",
) {
  const archived =
    speakerType === "system"
      ? null
      : room.publishMessage?.(
          actor,
          text,
          now,
          attachments,
          turnId,
          speakerType,
        );
  const message = {
    id: ++room.sequence,
    actor,
    text,
    now,
    speakerType,
    ...archived,
  };
  room.messages.push(message);
  if (room.messages.length > 160) room.messages.shift();
  return message;
}

function refill(room, now) {
  room.budget = room.maxTurns;
  setIntervalMinutes(room, room.minutes, now);
}

export function setIntervalMinutes(room, minutes, now = Date.now()) {
  room.minutes = minutes;
  room.nextRefill = minutes ? now + minutes * MINUTE : null;
}

export function refreshIfDue(room, now = Date.now()) {
  if (room.nextRefill === null || now < room.nextRefill) return false;
  refill(room, now);
  return true;
}

export function invite(room, role) {
  if (room.members[role.id] !== "home") return false;
  room.members[role.id] = "invited";
  room.notice = `已邀请${role.name}，等它来敲门。`;
  return true;
}

export function cancelInvite(room, role) {
  if (room.members[role.id] !== "invited") return false;
  room.members[role.id] = "home";
  room.notice = `已取消给${role.name}的邀请。`;
  return true;
}

export function decline(room, role) {
  if (room.members[role.id] !== "invited") return false;
  room.members[role.id] = "home";
  room.notice = `${role.name}这次来不了。`;
  return true;
}

export function arrive(room, role, now = Date.now()) {
  if (room.members[role.id] !== "invited") return false;
  room.members[role.id] = "here";
  room.notice = `${role.name}来坐啦。`;
  addMessage(room, "system", room.notice, now);
  return true;
}

export function leave(room, role, now = Date.now(), self = false) {
  if (room.members[role.id] !== "here") return false;
  room.members[role.id] = "home";
  room.waiting = room.waiting.filter(({ actor }) => actor !== role.id);
  if (room.turn?.actor === role.id) room.turn = null;
  delete room.bubbles[role.id];
  room.notice = self ? `${role.name}自己回家了。` : `${role.name}回家了。`;
  addMessage(room, "system", room.notice, now);
  return true;
}

export function speak(
  room,
  text,
  now = Date.now(),
  simulated = true,
  attachments = [],
) {
  const here = room.roles.filter(({ id }) => room.members[id] === "here");
  const content = text.trim();
  if (
    !here.length ||
    (!content && !attachments.length) ||
    content.length > 1000
  )
    return false;

  addMessage(
    room,
    "admin",
    content,
    now,
    attachments,
    undefined,
    "administrator",
  );
  refill(room, now);
  room.turn = null;
  const named = here.find((role) =>
    [role.name, role.title].some((name) => content.includes(`@${name}`)),
  );
  const first = named ?? here[room.starter++ % here.length];
  const order = [first, ...here.filter((role) => role !== first)];
  // Scripted reactions make the shared limit observable without a model.
  const rounds = simulated ? (here.length === 1 ? 1 : room.maxTurns) : 0;
  room.waiting = Array.from({ length: rounds }, (_, index) => {
    const role = order[index % order.length];
    return {
      actor: role.id,
      text: role.tone[Math.floor(index / order.length)] ?? role.tone.at(-1),
    };
  });
  return true;
}

export function startTurn(room) {
  if (room.turn || !room.budget || !room.waiting.length) return null;
  room.budget--;
  room.turn = room.waiting.shift();
  return room.turn;
}

export function finishTurn(
  room,
  turn,
  now = Date.now(),
  text = turn.text,
  turnId,
) {
  if (room.turn !== turn || room.members[turn.actor] !== "here") return false;
  if (text)
    room.bubbles[turn.actor] = addMessage(
      room,
      turn.actor,
      text,
      now,
      [],
      turnId,
      "agent",
    );
  room.turn = null;
  return true;
}
