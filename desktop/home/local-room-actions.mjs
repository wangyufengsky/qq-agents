import {
  arrive,
  cancelInvite,
  decline,
  finishTurn,
  invite,
  leave,
  setIntervalMinutes,
  speak,
  startTurn,
} from "./room.mjs";

export function createLocalRoomActions({
  context,
  room,
  bubbles,
  animateHome,
  showSprite,
  validInterval,
  savePreferences,
  update,
}) {
  const invitations = new Map();
  let finishTimer;

  function returnHome(role, self = false) {
    if (context.framework) return context.framework.act("leave", role.id);
    if (context.live) return context.live.leave(role);
    const turn = room.turn;
    if (!leave(room, role, Date.now(), self)) return;
    clearTimeout(bubbles.get(role.id));
    bubbles.delete(role.id);
    animateHome(role);
    if (room.turn !== turn) {
      clearTimeout(finishTimer);
      advance();
    }
    update();
  }

  function advance() {
    const turn = startTurn(room);
    if (!turn) return;
    update();
    finishTimer = setTimeout(() => {
      if (!finishTurn(room, turn)) return;
      clearTimeout(bubbles.get(turn.actor));
      const message = room.bubbles[turn.actor];
      bubbles.set(
        turn.actor,
        setTimeout(() => {
          if (room.bubbles[turn.actor] === message)
            delete room.bubbles[turn.actor];
          bubbles.delete(turn.actor);
          update();
        }, 4900),
      );
      update();
      advance();
    }, 1250);
  }

  function changeInvitation(role) {
    if (room.members[role.id] === "invited") {
      clearTimeout(invitations.get(role.id));
      invitations.delete(role.id);
      cancelInvite(room, role);
    } else if (invite(room, role)) {
      invitations.set(
        role.id,
        setTimeout(() => {
          invitations.delete(role.id);
          if (arrive(room, role)) showSprite(role);
          update();
        }, 2750),
      );
    }
    update();
  }

  function act(action, data, role) {
    const { live } = context;
    if (action === "invite" && role) {
      if (live) void live.invite(role);
      else changeInvitation(role);
    }
    if (action === "decline" && !live && role && decline(room, role)) {
      clearTimeout(invitations.get(role.id));
      invitations.delete(role.id);
      update();
    }
    if (action === "leave" && role) returnHome(role);
    if (action === "send" && typeof data === "string") {
      if (live) live.send(data);
      else if (speak(room, data)) {
        clearTimeout(finishTimer);
        advance();
        update();
      }
    }
    if (action === "interval" && validInterval(data) && data !== room.minutes) {
      if (live) live.interval(data);
      else setIntervalMinutes(room, data);
      savePreferences();
      update();
    }
    if (action === "door-mode") live?.setDoorMode(data);
    if (action === "knock-trial") void live?.offerOpportunity({ trial: true });
    if (action === "knock-answer" && typeof data === "boolean")
      live?.answerKnock(data);
  }

  return { act, returnHome };
}
