import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import { supportsMessageImages } from "../backends/capabilities.mjs";
import { containsCredential } from "../core/secrets.mjs";
import { imagePreview } from "../tools/image-preview.mjs";
import { imageMime } from "../tools/media.mjs";
import { desktopRoleToolsEnabled } from "../tools/desktop-policy.mjs";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 12 * 1024;
const MAX_CACHED = 8;
export const MAX_DESKTOP_ATTACHMENT_BODY =
  Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 512;

const formats = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);
const uploadSchema = z
  .object({
    client: z.string().uuid(),
    roomEpoch: z.string().uuid(),
    name: z.string().min(1).max(120),
    data: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_SOURCE_BYTES / 3) * 4),
  })
  .strict();

export function parseDesktopAttachment(input) {
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) throw Error("DESKTOP_ATTACHMENT_INVALID");
  const { client, roomEpoch, name, data } = parsed.data;
  const mimeType = formats.get(extname(name).toLowerCase());
  if (!mimeType || /[/\\\p{Cc}\p{Cf}]/u.test(name) || containsCredential(name))
    throw Error("DESKTOP_ATTACHMENT_INVALID");
  const source = Buffer.from(data, "base64");
  if (
    !source.length ||
    source.length > MAX_SOURCE_BYTES ||
    source.toString("base64") !== data
  )
    throw Error("DESKTOP_ATTACHMENT_INVALID");
  return { client, roomEpoch, name, mimeType, source };
}

function canReceive(config, agent, kind) {
  if (!agent || !desktopRoleToolsEnabled(config, agent)) return false;
  if (kind === "text")
    return agent.files?.enabled === true && agent.files.receive === true;
  const backend = config.backends.find(({ id }) => id === agent.backendId);
  return (
    agent.behavior.imageInput.enabled &&
    backend &&
    supportsMessageImages(backend)
  );
}

export class DesktopAttachments {
  #entries = new Map();
  busy = false;

  availability(config, roles) {
    const agents = config.agents.filter(({ id }) =>
      roles.some((role) => role.id === id),
    );
    return {
      text: agents.some((agent) => canReceive(config, agent, "text")),
      image: agents.some((agent) => canReceive(config, agent, "image")),
    };
  }

  async prepare(upload, config, roles) {
    const { name, mimeType, source } = upload;
    const meta = Object.freeze({
      id: randomUUID(),
      name,
      mimeType,
      bytes: source.length,
    });
    if (!mimeType.startsWith("image/")) {
      if (!this.availability(config, roles).text)
        throw Error("DESKTOP_ATTACHMENT_UNAVAILABLE");
      if (source.length > MAX_TEXT_BYTES)
        throw Error("DESKTOP_ATTACHMENT_INVALID");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(source);
      } catch {
        throw Error("DESKTOP_ATTACHMENT_INVALID");
      }
      if (
        !text.trim() ||
        /\p{Cc}/u.test(text.replace(/[\t\r\n]/g, "")) ||
        containsCredential(text)
      )
        throw Error("DESKTOP_ATTACHMENT_INVALID");
      return { meta, text };
    }
    const recipients = config.agents.filter(
      (agent) =>
        roles.some(({ id }) => id === agent.id) &&
        canReceive(config, agent, "image"),
    );
    if (!recipients.length) throw Error("DESKTOP_ATTACHMENT_UNAVAILABLE");
    if (imageMime(source) !== mimeType)
      throw Error("DESKTOP_ATTACHMENT_INVALID");
    const maxEdge = Math.min(
      1024,
      ...recipients.map((agent) => agent.behavior.imageInput.maxEdge),
    );
    try {
      const image = await imagePreview(source, {
        maxEdge,
        signal: AbortSignal.timeout(4500),
      });
      return { meta, image, maxEdge };
    } catch {
      throw Error("DESKTOP_ATTACHMENT_INVALID");
    }
  }

  publish(entry, config, visits, send) {
    const kind = entry.image ? "image" : "text";
    const imageBytes = entry.image
      ? Buffer.byteLength(entry.image.data, "base64")
      : 0;
    const recipients = new Map(
      config.agents
        .filter((agent) => {
          if (!visits.has(agent.id) || !canReceive(config, agent, kind))
            return false;
          const policy = agent.behavior.imageInput;
          return (
            !imageBytes ||
            (imageBytes <= policy.maxBytes && entry.maxEdge <= policy.maxEdge)
          );
        })
        .map((agent) => [agent.id, visits.get(agent.id)]),
    );
    if (!recipients.size) throw Error("DESKTOP_ATTACHMENT_UNAVAILABLE");
    this.#entries.set(entry.meta.id, { ...entry, recipients });
    try {
      // The room can prepare a model turn synchronously during publication.
      if (!send(entry.meta)) throw Error("DESKTOP_ATTACHMENT_UNAVAILABLE");
    } catch (error) {
      this.#entries.delete(entry.meta.id);
      throw error;
    }
    if (this.#entries.size > MAX_CACHED)
      this.#entries.delete(this.#entries.keys().next().value);
  }

  project(messages, config, agent, visit) {
    const imageInput = agent.behavior.imageInput;
    const images = [];
    let textBytes = 0;
    let imageBytes = 0;
    let imageEdge = 0;
    const prepared = messages.map((message) => {
      if (!message.attachments?.length) return message;
      const attachments = message.attachments.map((metadata) => {
        const entry = this.#entries.get(metadata.id);
        // A history lookup or a later visit carries only the public descriptor.
        if (!visit || entry?.recipients.get(agent.id) !== visit)
          return { ...metadata, contentUnavailable: true };
        if (entry.text && canReceive(config, agent, "text")) {
          const length = Buffer.byteLength(entry.text);
          if (textBytes + length <= MAX_TEXT_BYTES) {
            textBytes += length;
            return { ...metadata, text: entry.text };
          }
        }
        if (entry.image && canReceive(config, agent, "image")) {
          const length = Buffer.byteLength(entry.image.data, "base64");
          if (
            images.length < Math.min(imageInput.maxImages, 2) &&
            entry.maxEdge <= imageInput.maxEdge &&
            imageBytes + length <= imageInput.maxBytes
          ) {
            imageBytes += length;
            imageEdge = Math.max(imageEdge, entry.maxEdge);
            images.push({
              eventId: metadata.id,
              index: 0,
              label: `管理员发送的图片附件（资料）：${metadata.name}`,
              mimeType: entry.image.mimeType,
              data: entry.image.data,
            });
            return { ...metadata, includedAsImage: true };
          }
        }
        return { ...metadata, contentUnavailable: true };
      });
      return { ...message, attachments };
    });
    return {
      messages: prepared,
      images,
      assertCurrent(currentConfig, currentAgent, currentVisit) {
        const policy = currentAgent.behavior.imageInput;
        if (
          ((textBytes || images.length) && currentVisit !== visit) ||
          (textBytes && !canReceive(currentConfig, currentAgent, "text")) ||
          (images.length &&
            (!canReceive(currentConfig, currentAgent, "image") ||
              images.length > policy.maxImages ||
              imageBytes > policy.maxBytes ||
              imageEdge > policy.maxEdge))
        )
          throw Error("DESKTOP_ATTACHMENT_UNAVAILABLE");
      },
    };
  }
}
