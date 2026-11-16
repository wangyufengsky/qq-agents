// @ts-check
// Symbols stay inside the current process and never serialize into MCP or model input.
// Native image adapters recheck this lease before granting a delayed file read.
export const mediaLease = Symbol("mediaLease");

// Called only when an adapter proves submission of this exact image.
export const mediaSubmitted = Symbol("mediaSubmitted");
