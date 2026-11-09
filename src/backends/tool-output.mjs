// @ts-check
import { mcpResult } from "../tools/index.mjs";
import { safeToolFailure } from "../tools/errors.mjs";

/** @param {any} wire */
export function toolOutputText(wire) {
  return wire?.content?.[0]?.type === "text" ? wire.content[0].text : undefined;
}

/** Finalize after media projection and JSON serialization, before transport submission.
 * @param {Pick<import("./session-contract.mjs").RunParams, "finalizeToolOutput">} params
 * @param {unknown} original
 * @param {(value: any) => any | Promise<any>} [project]
 * @returns {Promise<{wire: any, receipt?: string}>}
 */
export async function finalizeMcpOutput(
  params,
  original,
  project = (value) => value,
) {
  const encode = async (/** @type {any} */ value) => {
    const content =
      value instanceof Error
        ? {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify(safeToolFailure(value)) },
            ],
          }
        : mcpResult(value);
    const wire = JSON.parse(JSON.stringify(await project(content)));
    return { wire, text: toolOutputText(wire) };
  };
  try {
    return await (params.finalizeToolOutput
      ? params.finalizeToolOutput(original, { encode, maxBytes: 65536 })
      : encode(original));
  } catch (error) {
    // Encoding failure must not escape an async HTTP listener or reuse a grant.
    return {
      wire: {
        isError: true,
        content: [
          { type: "text", text: JSON.stringify(safeToolFailure(error)) },
        ],
      },
    };
  }
}
