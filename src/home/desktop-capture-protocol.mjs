export const MAX_DESKTOP_CAPTURE_DISPLAYS = 24;
export const MAX_DESKTOP_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_DESKTOP_CAPTURE_ENCODED =
  Math.ceil(MAX_DESKTOP_CAPTURE_BYTES / 3) * 4;
export const MAX_DESKTOP_CAPTURE_WIRE_BYTES =
  MAX_DESKTOP_CAPTURE_ENCODED + 64 * 1024;

// Only in-process adapters need to distinguish full desktop capture from legacy window reads.
export const desktopCaptureBatch = Symbol("desktopCaptureBatch");
