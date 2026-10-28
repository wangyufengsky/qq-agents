import { githubPrivateContext } from "../github/policy.mjs";
import { sourceClass } from "./outbound-policy.mjs";

// This is a read boundary, not declassification. Stored records and the
// protection of any context that already saw them remain unchanged.
export function recallBoundary(runtime, ctx) {
  const privileged = githubPrivateContext(
    runtime.agent(ctx.agentId),
    ctx.conversation,
  );
  const restricted = (value) =>
    value?.protectedOperations === true ||
    value?.protectedRepositories?.length > 0;
  const classes = new Map();
  function protectedId(id) {
    if (typeof id !== "string") return false;
    if (!classes.has(id)) classes.set(id, sourceClass(runtime, ctx, id));
    return ["operations", "private-repository"].includes(classes.get(id));
  }
  function allowed(row) {
    if (privileged) return true;
    return (
      ![
        row,
        row?.metadata,
        row?.payload,
        ...(row?.evidenceSnapshot?.references || []).map((ref) => ref.metadata),
        ...(row?.counterEvidenceSnapshot?.references || []).map(
          (ref) => ref.metadata,
        ),
      ].some(restricted) &&
      ![row?.id, ...(row?.evidence || [])].some(protectedId)
    );
  }
  function project(row) {
    if (!allowed(row)) return null;
    // Scene projections omit protection metadata. Check their durable source
    // IDs too, and withhold the whole scene (including participant summaries).
    if (
      row.scene &&
      [
        ...(row.scene.messages || []),
        ...(row.scene.quoted || []),
        ...(row.scene.sharedRecords || []),
      ].some((item) => !allowed(item))
    ) {
      const { scene: _scene, ...safe } = row;
      return { ...safe, sceneWithheld: true };
    }
    return row;
  }
  return {
    allowed,
    assert(row) {
      if (!allowed(row)) throw Error("RECALL_SOURCE_NOT_ALLOWED");
    },
    rows: (rows) => rows.map(project).filter(Boolean),
  };
}

export function recallPage(runtime, ctx, page) {
  const boundary = recallBoundary(runtime, ctx);
  const items = boundary.rows(page.items || []);
  const diaries = page.diaries && boundary.rows(page.diaries);
  const withheld =
    (page.items?.length || 0) -
    items.length +
    (page.diaries?.length || 0) -
    (diaries?.length || 0);
  return {
    ...page,
    items,
    ...(diaries ? { diaries } : {}),
    ...(withheld
      ? {
          withheld,
          notice: `${page.notice || ""} Protected records were withheld before reading. Continue with the returned cursor; do not infer their contents.`,
        }
      : {}),
  };
}
