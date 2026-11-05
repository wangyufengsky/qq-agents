// @ts-check
// Symbols stay inside the current process and never serialize into MCP or model input.
// Native image adapters recheck this lease before granting a delayed file read.
export const mediaLease = Symbol("mediaLease");
