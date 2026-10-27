import { githubMarker, privateGithubSources } from "../github/policy.mjs";
import { sourceClass } from "./outbound-policy.mjs";

// Protection from the entire context, not only model-selected evidence IDs.
export function contextProtection(runtime, ctx) {
  return {
    protectedRepositories: privateGithubSources(ctx, runtime),
    protectedOperations: [...ctx.privateRead].some(
      (id) => sourceClass(runtime, ctx, id) === "operations",
    ),
  };
}
export function trackMindRecords(runtime, ctx, notes, kind = "work-note") {
  // Every model-facing record return and implicit handoff restores durable
  // markers; deleting an original source cannot erase read protection.
  for (const note of notes || []) {
    if (!note?.id) continue;
    ctx.privateRead.add(note.id);
    for (const id of note.evidence || []) ctx.privateRead.add(id);
    for (const repo of note.protectedRepositories || [])
      ctx.privateRead.add(githubMarker(repo));
    if (
      note.protectedOperations ||
      (note.evidence || []).some(
        (id) => sourceClass(runtime, ctx, id) === "operations",
      )
    )
      ctx.privateRead.add("operations:" + kind + ":" + note.id);
  }
  for (const repo of privateGithubSources(ctx, runtime))
    ctx.privateRead.add(githubMarker(repo));
  ctx.persistTaint?.();
}
