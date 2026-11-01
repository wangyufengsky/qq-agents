// @ts-check
import { digest } from "../core/value.mjs";

const maxBytes = 262144;
const hosts = ["qlogo.cn", "qpic.cn"];

/** The served type comes from the bytes, never from the remote content-type.
 * @param {Buffer} body */
export function avatarType(body) {
  if (body.length < 12) return null;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return "image/jpeg";
  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (
    body
      .subarray(0, 6)
      .toString("latin1")
      .match(/^GIF8[79]a$/)
  )
    return "image/gif";
  if (
    body.subarray(0, 4).toString("latin1") === "RIFF" &&
    body.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Content-addressed path: the page can show the image without learning the QQ account.
 * @param {{type:string,body:Buffer}} avatar */
export function avatarPath(avatar) {
  const ext = avatar.type.split("/")[1].replace("jpeg", "jpg");
  return `/avatars/${digest(avatar.body).slice(0, 32)}.${ext}`;
}

/** Fixed URL with no model-controlled input; any failure leaves the letter fallback.
 * @param {string} accountId @param {{fetch?:typeof fetch,timeoutMs?:number}} [options] */
export async function fetchQqAvatar(
  accountId,
  { fetch: request = fetch, timeoutMs = 5000 } = {},
) {
  if (!/^[1-9][0-9]{4,11}$/.test(accountId)) return null;
  try {
    const response = await request(
      `https://q1.qlogo.cn/g?b=qq&nk=${accountId}&s=100`,
      { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" },
    );
    const host = new URL(response.url || "https://q1.qlogo.cn/").hostname;
    if (
      !response.ok ||
      !hosts.some((h) => host === h || host.endsWith("." + h)) ||
      Number(response.headers.get("content-length") || 0) > maxBytes
    )
      return null;
    const body = Buffer.from(await response.arrayBuffer());
    const type = body.length <= maxBytes ? avatarType(body) : null;
    return type ? { type, body } : null;
  } catch {
    return null;
  }
}
