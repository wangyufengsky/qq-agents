import test from "node:test";
import assert from "node:assert/strict";
import {
  socialBudgetValues,
  socialBudgetFields,
  socialResourceSummary,
} from "../public/home-space/social.mjs";
const valid = () => ({
  maxInputTokensPerInference: "1047576",
  maxOutputTokensPerInference: "100",
  maxTokensPerTurn: "1047676",
  maxTokensPerWindow: "2095352",
  maxTokensPerDay: "3143028",
  maxInferencesPerTurn: "2",
});
test("social budgets remain unconfigured by default and preserve exact token units", () => {
  assert.equal(socialBudgetValues("unconfigured", {}), null);
  const budget = socialBudgetValues("configured", valid());
  assert.equal(budget.unit, "tokens");
  assert.equal(budget.maxInputTokensPerInference, 1047576);
});
test("social budgets reject missing, noninteger and out-of-range values", () => {
  for (const [key, , max] of socialBudgetFields)
    for (const value of ["", "0", "1.5", String(max + 1)])
      assert.throws(
        () => socialBudgetValues("configured", { ...valid(), [key]: value }),
        /整数/,
      );
});
test("social budgets require per-turn coverage and window/day coverage", () => {
  assert.throws(
    () =>
      socialBudgetValues("configured", {
        ...valid(),
        maxTokensPerTurn: "1047576",
      }),
    /输入与输出/,
  );
  for (const key of ["maxTokensPerWindow", "maxTokensPerDay"])
    assert.throws(
      () => socialBudgetValues("configured", { ...valid(), [key]: "1" }),
      /每时段和每日/,
    );
});

test("round-based resource summaries distinguish uncapped, unavailable and unknown limits", () => {
  const unmetered = socialResourceSummary({
    used: 0,
    reserved: 0,
    limit: null,
    usageAvailable: false,
  });
  assert.match(unmetered, /后端未提供可信用量/);
  assert.match(unmetered, /未设 token 硬上限/);
  assert.doesNotMatch(unmetered, /0已用/);
  const metered = socialResourceSummary({ used: 10, reserved: 20, limit: 100 });
  assert.match(metered, /10已用 \/ 20预留/);
  assert.match(metered, /时段100 token/);
  const async = socialResourceSummary(
    {
      usageAvailable: false,
      limits: { perTurn: null, perDay: null },
    },
    true,
  );
  assert.match(async, /每回合未设 token 硬上限，每日未设 token 硬上限/);
  assert.match(socialResourceSummary(undefined), /待核对/);
});
