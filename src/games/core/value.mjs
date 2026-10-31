// @ts-check
import { createHash, randomBytes } from "node:crypto";

export class GameError extends Error {
  /** @param {string} code @param {number} [status] */
  constructor(code, status = 409) {
    super(code);
    this.status = status;
  }
}
/** @param {string} code @param {number} [status] @returns {never} */
export function fail(code, status) {
  throw new GameError(code, status);
}
/** @param {unknown} value @returns {string} */
export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical(/** @type {any} */ (value)[k])}`,
      )
      .join(",")}}`;
  return fail("INVALID_JSON", 400);
}
/** @param {unknown} value @param {number} limit @param {string} [code] */
export function bounded(value, limit, code = "GAME_LIMIT_EXCEEDED") {
  const text = canonical(value);
  if (Buffer.byteLength(text) > limit) fail(code, 413);
  return text;
}
/** @param {string|Buffer} value */
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
/** @template T @param {T} value @returns {T} */
export function immutable(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}
/** @param {import('zod').ZodType} schema @param {unknown} value @param {string} [code] @returns {any} */
export function parse(schema, value, code = "INVALID_REQUEST") {
  const result = schema.safeParse(value);
  if (!result.success) fail(code, 400);
  return result.data;
}
