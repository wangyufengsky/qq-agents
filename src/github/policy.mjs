import { z } from "zod";

export const repositoryName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
  .refine((s) => ![".", ".."].includes(s.split("/")[1]))
  .toLowerCase();
export const githubPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    auth: z.enum(["token", "gh"]).default("token"),
    tokenEnv: z
      .string()
      .regex(/^QQ_GITHUB_[A-Z0-9_]{1,90}$/)
      .default("QQ_GITHUB_READ_TOKEN"),
    privateRepositories: z.array(repositoryName).max(20).default([]),
    maxRequestsPerTurn: z.number().int().min(1).max(50).default(15),
    maxRequestsPerDay: z.number().int().min(1).max(1000).default(150),
  })
  .strict()
  .prefault({});
export const githubMarker = (repo) => "github-private:" + repo.toLowerCase();
export function privateGithubSources(ctx, runtime) {
  const repos = new Set(
    [...ctx.privateRead]
      .filter((id) => id.startsWith("github-private:"))
      .map((id) => id.slice("github-private:".length)),
  );
  if (runtime) {
    const memory = runtime.memory.bind(ctx.agentId);
    const lookup = memory.db.prepare(
      "SELECT payload AS metadata FROM events WHERE agent_id=? AND id=? UNION ALL SELECT metadata FROM diaries WHERE agent_id=? AND id=? UNION ALL SELECT value AS metadata FROM work_notes WHERE agent_id=? AND id=? UNION ALL SELECT value AS metadata FROM intentions WHERE agent_id=? AND id=?",
    );
    for (const id of ctx.privateRead)
      for (const row of lookup.all(
        ctx.agentId,
        id,
        ctx.agentId,
        id,
        ctx.agentId,
        id,
        ctx.agentId,
        id,
      ))
        for (const repo of JSON.parse(row.metadata).protectedRepositories || [])
          repos.add(repo);
  }
  return [...repos];
}
export const githubPrivateContext = (agent, conversation) =>
  conversation === "@subject" ||
  agent.ownerIds.some((id) => conversation === `private:${id}`);
