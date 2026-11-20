import { z } from "zod";

const maxEvidence = 2;
const maxIdLength = 120;
const maxContribution = 80;

export const functionalResultInstructions = `调用 functional_agent_result 只用以下两种提交方式。无新增信息时，参数为 {"evidenceIds":[]}，省略 contribution。有新增信息时，填入 1 至 ${maxEvidence} 条本轮可用的证据记录 ID（每个 ID 1 至 ${maxIdLength} 字符），并用 contribution 写一行 1 至 ${maxContribution} 字符的说明，说明证据补上了什么。`;

export const functionalResultHints = new Map([
  [
    "contribution_required",
    `有证据时必须填写 contribution，用一行不超过 ${maxContribution} 字符的短话说明补上了什么。`,
  ],
  [
    "contribution_must_be_omitted",
    '无新增信息时只提交 {"evidenceIds":[]}，省略 contribution。',
  ],
]);

export const functionalResultSchema = z
  .strictObject({
    evidenceIds: z.array(z.string().min(1).max(maxIdLength)).max(maxEvidence),
    contribution: z
      .string()
      .trim()
      .min(1)
      .max(maxContribution)
      .regex(/^[^\r\n\u2028\u2029]+$/u)
      .optional(),
  })
  .superRefine(({ evidenceIds, contribution }, ctx) => {
    if (
      evidenceIds.length
        ? contribution !== undefined
        : contribution === undefined
    )
      return;
    ctx.addIssue({
      code: "custom",
      path: ["contribution"],
      params: {
        rule: evidenceIds.length
          ? "contribution_required"
          : "contribution_must_be_omitted",
      },
    });
  });

// Zod's JSON Schema projection cannot carry a cross-field refinement.
export const functionalResultSchemaConditions = {
  if: {
    properties: { evidenceIds: { maxItems: 0 } },
    required: ["evidenceIds"],
  },
  then: { not: { required: ["contribution"] } },
  else: { required: ["contribution"] },
};
