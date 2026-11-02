// @ts-check
export const GROUP_READ_MAX_MEMBERS = 10000;
export const GROUP_READ_MAX_BYTES = 4 * 1024 * 1024;
const roles = new Set(["owner", "admin", "member"]);

/** @param {any} value @returns {string} */
function identity(value) {
  const id =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
  if (!/^[1-9]\d{0,19}$/.test(id)) throw Error("GROUP_READ_IDENTITY_MISMATCH");
  return id;
}
/** @param {any} value @returns {string|null} */
function text(value) {
  if (value == null) return null;
  if (typeof value !== "string") throw Error("GROUP_READ_RESPONSE_INVALID");
  return value.slice(0, 200);
}
/** @param {any} value @returns {number|null} */
function count(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000)
    throw Error("GROUP_READ_RESPONSE_INVALID");
  return value;
}
/** @param {any} value @param {string} groupId @param {{raw?:boolean}} [options] */
export function projectGroupInfo(value, groupId, { raw = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("GROUP_READ_RESPONSE_INVALID");
  if (identity(raw ? value.group_id : value.groupId) !== identity(groupId))
    throw Error("GROUP_READ_IDENTITY_MISMATCH");
  const memberCount = count(raw ? value.member_count : value.memberCount);
  const maxMemberCount = count(
    raw ? value.max_member_count : value.maxMemberCount,
  );
  if (
    memberCount !== null &&
    maxMemberCount !== null &&
    memberCount > maxMemberCount
  )
    throw Error("GROUP_READ_RESPONSE_INVALID");
  return {
    groupId,
    name: text(raw ? value.group_name : value.name),
    memberCount,
    maxMemberCount,
  };
}
/** @param {any} value @param {string} groupId @param {{raw?:boolean}} [options] */
export function projectGroupMembers(value, groupId, { raw = false } = {}) {
  identity(groupId);
  if (!Array.isArray(value)) throw Error("GROUP_READ_RESPONSE_INVALID");
  if (value.length > GROUP_READ_MAX_MEMBERS)
    throw Error("GROUP_READ_LIMIT_EXCEEDED");
  const seen = new Set();
  let ownerCount = 0;
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw Error("GROUP_READ_RESPONSE_INVALID");
    if (identity(raw ? row.group_id : row.groupId) !== groupId)
      throw Error("GROUP_READ_IDENTITY_MISMATCH");
    const userId = identity(raw ? row.user_id : row.userId);
    if (seen.has(userId)) throw Error("GROUP_READ_IDENTITY_MISMATCH");
    seen.add(userId);
    if (row.role != null && typeof row.role !== "string")
      throw Error("GROUP_READ_RESPONSE_INVALID");
    const role = roles.has(row.role) ? row.role : null;
    if (role === "owner" && ++ownerCount > 1)
      throw Error("GROUP_READ_RESPONSE_INVALID");
    return {
      userId,
      groupId,
      nickname: text(row.nickname),
      card: text(row.card),
      title: text(row.title),
      role,
    };
  });
}

/** @param {any} transport @param {"info"|"members"} kind @param {{groupId:string,signal?:AbortSignal}} args */
export async function readGroupGateway(transport, kind, { groupId, signal }) {
  try {
    identity(groupId);
    if (signal?.aborted) throw Error("ABORTED");
    const data = await transport.call(
      kind === "info" ? "get_group_info" : "get_group_member_list",
      { group_id: groupId, no_cache: true },
      10000,
      { maxBytes: GROUP_READ_MAX_BYTES, signal },
    );
    if (signal?.aborted) throw Error("ABORTED");
    return kind === "info"
      ? projectGroupInfo(data, groupId, { raw: true })
      : projectGroupMembers(data, groupId, { raw: true });
  } catch (error) {
    const caught = /** @type {any} */ (error);
    const code =
      signal?.aborted || caught?.message === "ABORTED"
        ? "ABORTED"
        : caught?.reason === "ACTION_UNSUPPORTED"
          ? "GROUP_READ_UNSUPPORTED"
          : caught?.message === "ONEBOT_RESPONSE_TOO_LARGE"
            ? "GROUP_READ_LIMIT_EXCEEDED"
            : [
                  "GROUP_READ_IDENTITY_MISMATCH",
                  "GROUP_READ_RESPONSE_INVALID",
                  "GROUP_READ_LIMIT_EXCEEDED",
                ].includes(caught?.message)
              ? caught.message
              : "GROUP_READ_FAILED";
    // eslint-disable-next-line preserve-caught-error -- gateway failures may contain raw credentials or group content.
    throw Error(code);
  }
}
