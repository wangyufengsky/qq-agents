import { basename, extname } from "node:path";
import {
  MAX_DESKTOP_VIDEO_BYTES,
  VIDEO_EXTENSIONS,
} from "../../src/video/frames.mjs";
import { openNoFollowAsync } from "../../src/core/no-follow.mjs";

export function registerPersonalIpc({
  ipc,
  context,
  dialog,
  showPanel,
  entries,
  send,
}) {
  let personalSelection;
  function personalTarget(agentId, roomEpoch, visitId) {
    return Boolean(
      context.framework &&
      context.remoteState?.connected &&
      !context.remoteState.connectionLost &&
      !context.hidden &&
      !context.desktopLocked &&
      context.remoteState.roomEpoch === roomEpoch &&
      context.remoteState.roles.some(
        (role) =>
          role.id === agentId &&
          role.state === "here" &&
          role.bodyVisitId === visitId,
      ),
    );
  }

  function deliverPersonal(value, reveal = false) {
    if (reveal) showPanel("chat");
    const panel = entries.get("panel");
    if (panel?.ready) send(panel, "room:personal", value);
    else
      panel?.win.webContents.once("did-finish-load", () => {
        if (personalSelection === value.target)
          send(panel, "room:personal", value);
      });
  }

  ipc.on("room:personal-drop", async (event, drop) => {
    const entry = ipc.actionEntry(event);
    if (
      !entry ||
      !["door", "sprite"].includes(entry.type) ||
      !context.remoteState?.roomEpoch
    )
      return;
    const roomEpoch = context.remoteState.roomEpoch;
    const candidates = context.remoteState.roles.filter(
      (role) =>
        role.state === "here" &&
        role.bodyVisitId &&
        (entry.type === "door" || role.id === entry.id),
    );
    if (
      !candidates.length ||
      !drop ||
      !Number.isInteger(drop.fileCount) ||
      drop.fileCount > 1
    )
      return;
    let role = candidates[0];
    if (entry.type === "door") {
      const choice = await dialog.showMessageBox(entry.win, {
        type: "question",
        title: "选择接收者",
        message: "要私密交给谁？",
        buttons: [...candidates.map((item) => item.name), "取消"],
        cancelId: candidates.length,
        noLink: true,
      });
      role = candidates[choice.response];
    }
    if (
      !role ||
      ipc.actionEntry(event) !== entry ||
      !personalTarget(role.id, roomEpoch, role.bodyVisitId)
    )
      return;
    let payload;
    let attempted;
    try {
      if (drop.fileCount === 1 && typeof drop.path === "string") {
        const name = basename(drop.path);
        if (
          name.length > 120 ||
          ![".png", ".jpg", ".jpeg", ".webp"].includes(
            extname(name).toLowerCase(),
          )
        )
          return;
        const file = await openNoFollowAsync(drop.path);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > 2 * 1024 * 1024)
            return;
          const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await file.read(
              buffer,
              length,
              buffer.length - length,
            );
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (!length || length > 2 * 1024 * 1024) return;
          payload = {
            attachment: {
              name,
              data: buffer.subarray(0, length).toString("base64"),
            },
          };
        } finally {
          await file.close();
        }
      } else if (
        drop.fileCount === 0 &&
        typeof drop.text === "string" &&
        drop.text.trim() &&
        drop.text.length <= 12000
      ) {
        payload = { text: drop.text };
      } else return;
      if (
        ipc.actionEntry(event) !== entry ||
        !personalTarget(role.id, roomEpoch, role.bodyVisitId)
      )
        return;
      const target = { agentId: role.id, roomEpoch, visitId: role.bodyVisitId };
      personalSelection = attempted = target;
      deliverPersonal({ target, name: role.name, pending: true }, true);
      const result = await context.framework.personal("personal-drop", {
        ...target,
        ...payload,
      });
      if (
        personalSelection === target &&
        personalTarget(role.id, roomEpoch, role.bodyVisitId)
      )
        deliverPersonal({ target, messages: result.messages });
    } catch {
      if (
        attempted &&
        personalSelection === attempted &&
        personalTarget(role.id, roomEpoch, role.bodyVisitId)
      )
        deliverPersonal({
          target: personalSelection,
          error: "发送结果未确认，请先查看私密记录。",
        });
    }
  });

  ipc.handle("room:personal", async (event, action, data) => {
    const entry = ipc.actionEntry(event);
    if (action === "open") {
      const role = context.remoteState?.roles.find(
        ({ id }) => id === data?.agentId,
      );
      if (
        entry?.type !== "panel" ||
        !entry.win.isFocused() ||
        !role ||
        !personalTarget(role.id, data?.roomEpoch, data?.visitId)
      )
        return { status: "CLOSED" };
      const target = {
        agentId: role.id,
        roomEpoch: data.roomEpoch,
        visitId: data.visitId,
      };
      personalSelection = target;
      deliverPersonal({ target, name: role.name, pending: true }, true);
      try {
        const result = await context.framework.personal(
          "personal-history",
          target,
        );
        if (
          personalSelection === target &&
          personalTarget(role.id, target.roomEpoch, target.visitId)
        )
          deliverPersonal({ target, messages: result.messages });
        return { status: "opened" };
      } catch {
        if (
          personalSelection === target &&
          personalTarget(role.id, target.roomEpoch, target.visitId)
        )
          deliverPersonal({ target, error: "暂时无法读取私密记录。" });
        return { status: "unavailable" };
      }
    }
    const selected = personalSelection;
    if (
      entry?.type !== "panel" ||
      !data ||
      !selected ||
      data.agentId !== selected.agentId ||
      data.roomEpoch !== selected.roomEpoch ||
      data.visitId !== selected.visitId ||
      !personalTarget(selected.agentId, selected.roomEpoch, selected.visitId)
    )
      return { status: "CLOSED" };
    const target = {
      agentId: selected.agentId,
      roomEpoch: selected.roomEpoch,
      visitId: selected.visitId,
    };
    let result;
    if (action === "history")
      result = await context.framework.personal("personal-history", target);
    else if (
      action === "send" &&
      typeof data.text === "string" &&
      data.text.trim() &&
      data.text.length <= 12000
    )
      result = await context.framework.personal("personal-drop", {
        ...target,
        text: data.text,
      });
    else return { status: "CLOSED" };
    if (
      personalSelection !== selected ||
      !personalTarget(selected.agentId, selected.roomEpoch, selected.visitId)
    )
      return { status: "CLOSED" };
    return result;
  });

  let choosingAttachment = false;
  ipc.handle("room:attach", async (event) => {
    const entry = ipc.entryFor(event);
    const availability = context.remoteState?.attachmentInput;
    const roomEpoch = context.remoteState?.roomEpoch;
    if (
      !context.framework ||
      !roomEpoch ||
      entry?.type !== "panel" ||
      entry.departing ||
      entry.section !== "chat" ||
      !entry.win.isFocused() ||
      choosingAttachment ||
      (!availability?.text && !availability?.image && !availability?.video)
    )
      return "unavailable";
    const imageExtensions = ["png", "jpg", "jpeg", "webp"];
    const extensions = [
      ...(availability.text ? ["txt", "md", "csv", "json"] : []),
      ...(availability.image ? imageExtensions : []),
      ...(availability.video ? VIDEO_EXTENSIONS : []),
    ];
    choosingAttachment = true;
    try {
      const selection = await dialog.showOpenDialog(entry.win, {
        title: "发送附件到桌面小窝",
        buttonLabel: "发送",
        properties: ["openFile"],
        filters: [{ name: "桌面小窝支持的附件", extensions }],
      });
      if (selection.canceled) return "cancelled";
      const [selected] = selection.filePaths;
      const name = basename(selected);
      const extension = extname(name).slice(1).toLowerCase();
      if (!extensions.includes(extension) || name.length > 120)
        return "invalid";
      const isVideo = VIDEO_EXTENSIONS.includes(extension);
      const maxBytes = isVideo
        ? MAX_DESKTOP_VIDEO_BYTES
        : imageExtensions.includes(extension)
          ? 2 * 1024 * 1024
          : 12 * 1024;
      const file = await openNoFollowAsync(selected);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes)
          return "invalid";
        if (isVideo) {
          const stream = file.createReadStream({
            autoClose: false,
            end: stat.size - 1,
          });
          try {
            await context.framework.attachVideo(
              { roomEpoch, name },
              { stream, bytes: stat.size },
            );
            return "sent";
          } finally {
            stream.destroy();
          }
        }
        const buffer = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            length,
            buffer.length - length,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (!length || length > maxBytes) return "invalid";
        await context.framework.attach({
          roomEpoch,
          name,
          data: buffer.subarray(0, length).toString("base64"),
        });
        return "sent";
      } finally {
        await file.close();
      }
    } catch {
      return "failed";
    } finally {
      choosingAttachment = false;
    }
  });

  return {
    personalTarget,
    get selection() {
      return personalSelection;
    },
    clearSelection() {
      personalSelection = undefined;
    },
  };
}
