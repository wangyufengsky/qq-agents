import test from "node:test";
import assert from "node:assert/strict";
import { containsCredential } from "../src/core/secrets.mjs";
import { fixture, context } from "./helpers.mjs";

test("credential prefixes must begin a token, so ordinary words still pass", () => {
  for (const text of [
    "推荐看 https://example.com/risk-assessment-guidelines",
    "desk-organizer-ideas-for-2026",
    "task-scheduler-configuration",
    "github_pattern_matching_notes",
    "my sk-short",
  ])
    assert.equal(containsCredential(text), false, text);
  for (const text of [
    "sk-" + "x".repeat(24),
    "key=sk-proj-" + "a".repeat(20),
    "https://example.com/?q=sk-abcdefghijklmnopqrstuvw",
    "ghp_" + "c".repeat(24),
    "github_pat_" + "d".repeat(24),
    "Authorization: Bearer " + "b".repeat(24),
  ])
    assert.equal(containsCredential(text), true, text);
});

test("QQ text with a hyphenated word ending in sk- is delivered", async (t) => {
  const { runtime } = fixture(t);
  const ctx = context(runtime);
  const r = await runtime.send(ctx, {
    requestId: "risk-link",
    text: "参考 https://example.com/risk-assessment-guidelines",
  });
  assert.equal(r.status, "sent");
  await assert.rejects(
    runtime.send(ctx, {
      requestId: "pat",
      text: "github_pat_" + "d".repeat(24),
    }),
    /SENSITIVE_OUTPUT_BLOCKED/,
  );
});
