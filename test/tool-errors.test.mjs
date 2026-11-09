import test from "node:test";
import assert from "node:assert/strict";
import { config, context, fixture } from "./helpers.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";

test("argument diagnostics show schema paths, array indexes, union branches and formats safely", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_send_burst");
  const { runtime, store } = fixture(t, { cfg });
  const ctx = context(runtime);
  const secret = "SYNTHETIC_SECRET_NOT_FOR_DIAGNOSTICS";
  async function invalid(tool, args) {
    let failure;
    await assert.rejects(runtime.callTool(ctx, tool, args), (error) => {
      failure = safeToolFailure(error);
      return failure.code === "INVALID_TOOL_ARGUMENTS";
    });
    assert(!JSON.stringify(failure).includes(secret));
    return failure.issues;
  }
  assert.deepEqual(
    await invalid("qq_mark_read", { throughSeq: 0, [secret]: secret }),
    [{ field: "$", code: "unrecognized_keys" }],
  );
  assert.deepEqual(
    await invalid("qq_draft", {
      action: "continue",
      draftId: secret,
      expectedVersion: secret,
    }),
    [
      { field: "draftId", code: "invalid_format", format: "uuid" },
      { field: "expectedVersion", code: "invalid_type", expected: "number" },
    ],
  );
  assert.deepEqual(
    await invalid("diary_write", {
      title: "样例",
      body: "样例",
      evidence: { value: secret },
    }),
    [{ field: "evidence", code: "invalid_type", expected: "array" }],
  );
  ctx.messageTimingId = 1;
  assert.deepEqual(await invalid("qq_draft", null), [
    { field: "$", code: "invalid_type", expected: "object" },
  ]);
  delete ctx.messageTimingId;
  const mem = store.bind(ctx.agentId);
  const protectedSource = mem.append({
    dedupe: "restricted",
    kind: "external.read",
    conversation: ctx.conversation,
    payload: { protectedOperations: true },
  });
  await assert.rejects(
    runtime.callTool(ctx, "diary_write", {
      title: "样例",
      body: "样例",
      evidence: [protectedSource.id],
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  const issues = await invalid("qq_send_burst", {
    requestId: "diagnostic",
    messages: [{ segments: [{ type: "text", text: { value: secret } }] }],
  });
  assert(
    issues.some(
      ({ field, code }) => field === "messages[0]" && code === "invalid_union",
    ),
  );
  assert(
    issues.some(
      ({ field, code, expected }) =>
        field === "messages[0].segments[0].text" &&
        code === "invalid_type" &&
        expected === "string",
    ),
  );
});
