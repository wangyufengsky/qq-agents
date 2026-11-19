// @ts-check
import { z } from "zod";
import { registry } from "./registry.mjs";
import {
  DESKTOP_BODY_CONTROL,
  DESKTOP_BROWSER_CONTROL,
  DESKTOP_NATIVE_CONTROL,
  TOOL_NAMES,
} from "./names.mjs";
import { legacyNativeActionSchema } from "../home/desktop-native.mjs";
import { legacyBrowserActionSchema } from "../home/desktop-browser.mjs";
import {
  bodyActionSchema,
  desktopPublicWaveSchema,
  legacyBodyActionSchema,
  windowApproachAction,
  standardInteractiveBodyActionSchema,
} from "../home/desktop-body-protocol.mjs";
export { TOOL_NAMES } from "./names.mjs";

const legacyBodyDescription =
  "根据管理员新的桌边指令控制你自己的桌宠浮窗。move 的 door 是去小门旁，seat 是坐回座位，仅限同屏。state 读取位置，pose 调整朝向，stop 停止，status 用原 requestId 查询本轮结果。每个新操作使用不同 requestId，等待 completed 后才确认完成。手动接管后等管理员的新指令，取消或未确认时不换 ID 重试。";
export function toolSpecs(
  enabled = TOOL_NAMES,
  {
    context = false,
    desktopUnified = false,
    desktopBodyV2 = true,
    desktopBodyCrossDisplay = false,
    desktopBodyInteractions = false,
    desktopPublicWave = false,
    desktopWindowApproach = false,
  } = {},
) {
  return enabled
    .filter((n) => Object.hasOwn(registry, n))
    .map((name) => {
      const { description, schema } = registry[name];
      const nativeControl = name === DESKTOP_NATIVE_CONTROL;
      const browserControl = name === DESKTOP_BROWSER_CONTROL;
      const scopedSchema = desktopUnified
        ? schema
        : nativeControl
          ? legacyNativeActionSchema
          : browserControl
            ? legacyBrowserActionSchema
            : schema;
      const controlDescription = nativeControl
        ? "在获准的本机窗口操作。grants 列出你自己的授权。有多个目标时填写 grantId。先 observe 获取当轮元素引用，再 click、set-value 或 scroll。revoke 撤销你自己的指定授权。发出后结果未确认时勿自动重试。"
        : "在获准的独立网页会话内操作。grants 列出你自己的授权。有多个目标时填写 grantId。使用 navigate 或 observe 获取当轮元素引用，再 click 或 fill。close 关闭浏览器目标，revoke 撤销你自己的指定授权。";
      const body = name === DESKTOP_BODY_CONTROL;
      const legacyBody = body && !desktopBodyV2;
      const bodyDescription =
        body && desktopBodyCrossDisplay && typeof description === "string"
          ? description.replace(
              "移动仅限同屏",
              "可沿相邻工作区跨屏移动，间隙或过窄边界不可达",
            )
          : description;
      const actionSchema =
        body && desktopWindowApproach
          ? z.union([
              desktopBodyInteractions
                ? standardInteractiveBodyActionSchema
                : desktopPublicWave
                  ? desktopPublicWaveSchema
                  : bodyActionSchema,
              windowApproachAction,
            ])
          : undefined;
      const inputSchema = z.toJSONSchema(
        /** @type {import("zod").ZodType} */ (
          legacyBody
            ? legacyBodyActionSchema
            : actionSchema
              ? actionSchema
              : body && !desktopBodyInteractions
                ? desktopPublicWave
                  ? desktopPublicWaveSchema
                  : bodyActionSchema
                : body
                  ? standardInteractiveBodyActionSchema
                  : scopedSchema
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
      const approachDescription =
        desktopWindowApproach && body
          ? " 可用 approach-window 靠近当前获准关注的窗口；手动移动会立即接管。"
          : "";
      return {
        name,
        description:
          desktopUnified && (nativeControl || browserControl)
            ? controlDescription
            : (legacyBody
                ? legacyBodyDescription
                : body && desktopBodyInteractions
                  ? bodyDescription +
                    " gesture 播放 jump、climb、land 或 wave。interaction 仅用于本轮双方已同意的互动步骤，填入提示中的 interactionId。" +
                    (desktopPublicWave
                      ? " 点名挥手用 recipient，回应已有招呼可附 replyTo。"
                      : "")
                  : body && desktopPublicWave
                    ? bodyDescription +
                      " 可向在场角色挥手。用 gesture 的 wave 搭配 recipient，回礼可附 publicSpace.recent 中的 replyTo。双方同意的协作步骤使用 interaction 和提示里的 interactionId。"
                    : bodyDescription) + approachDescription,
        inputSchema,
      };
    });
}
