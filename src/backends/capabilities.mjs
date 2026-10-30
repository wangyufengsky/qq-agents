// @ts-check
// What the runtime may rely on beyond run(). Missing features degrade: no
// compaction retires the session under pressure, no image generation hides
// generated_image_list.
export const BACKEND_CAPABILITIES = {
  dsh: { compaction: true, imageGeneration: false },
  codex: { compaction: true, imageGeneration: true },
  openai: { compaction: false, imageGeneration: false },
  antigravity: { compaction: false, imageGeneration: false },
};
/** @param {string} type */
export const backendCapabilities = (type) =>
  BACKEND_CAPABILITIES[
    /** @type {keyof typeof BACKEND_CAPABILITIES} */ (type)
  ] || { compaction: false, imageGeneration: false };
