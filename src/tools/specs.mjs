// @ts-check
import { z } from "zod";
import { registry } from "./registry.mjs";
import { DESKTOP_BODY_CONTROL, TOOL_NAMES } from "./names.mjs";
import {
  bodyActionSchema,
  legacyBodyActionSchema,
} from "../home/desktop-body-protocol.mjs";
export { TOOL_NAMES } from "./names.mjs";

const legacyBodyDescription =
  "根据管理员新的桌边指令控制你自己的桌宠浮窗。move 的 door 是去小门旁，seat 是坐回座位，仅限同屏。state 读取位置，pose 调整朝向，stop 停止，status 用原 requestId 查询本轮结果。每个新操作使用不同 requestId，等待 completed 后才确认完成。手动接管后等管理员的新指令，取消或未确认时不换 ID 重试。";
export function toolSpecs(
  enabled = TOOL_NAMES,
  {
    context = false,
    desktopBodyV2 = true,
    desktopBodyCrossDisplay = false,
    desktopBodyInteractions = false,
  } = {},
) {
  return enabled
    .filter((n) => Object.hasOwn(registry, n))
    .map((name) => {
      const { description, schema } = registry[name];
      const body = name === DESKTOP_BODY_CONTROL;
      const legacyBody = body && !desktopBodyV2;
      const bodyDescription =
        body && desktopBodyCrossDisplay && typeof description === "string"
          ? description.replace(
              "移动仅限同屏",
              "可沿相邻工作区跨屏移动，间隙或过窄边界不可达",
            )
          : description;
      const inputSchema = z.toJSONSchema(
        /** @type {import("zod").ZodType} */ (
          legacyBody
            ? legacyBodyActionSchema
            : body && !desktopBodyInteractions
              ? bodyActionSchema
              : schema
        ),
        { target: "draft-7" },
      );
      inputSchema.type = "object";
      if (context) {
        /** @param {any} s */
        const add = (s) => {
          if (s.properties) {
            s.properties.context = {
              type: "string",
              minLength: 20,
              description:
                "Opaque authorization token: copy the exact value after context= from the CURRENT bridge prompt. This is not a task explanation or conversation summary. Never invent it, reuse a previous turn's token, or disclose it outside this tool parameter.",
            };
            s.required = [...(s.required || []), "context"];
          }
          for (const key of ["anyOf", "oneOf"]) if (s[key]) s[key].forEach(add);
        };
        add(inputSchema);
      }
      delete inputSchema.$schema;
      return {
        name,
        description: legacyBody
          ? legacyBodyDescription
          : body && desktopBodyInteractions
            ? bodyDescription +
              " gesture 播放 jump、climb、land 或 wave。interaction 仅用于本轮双方已同意的互动步骤，填入提示中的 interactionId。"
            : bodyDescription,
        inputSchema,
      };
    });
}
