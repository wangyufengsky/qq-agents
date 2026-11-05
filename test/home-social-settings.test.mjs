import test from "node:test";
import assert from "node:assert/strict";
import {
  socialBudgetValues,
  socialBudgetFields,
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
