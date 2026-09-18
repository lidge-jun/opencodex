// Thin facade over the cohesive leaf modules under ./kiro/. Every name this file exported
// before the split is re-exported here, spelled identically, so existing consumers of
// "src/adapters/kiro" keep working unchanged.
export type { KiroReasoningMode } from "./kiro/reasoning";
export { kiroReasoningMode } from "./kiro/reasoning";
export { boundedInjectedInstructionForTests, buildKiroPayload } from "./kiro/payload";
export { isRetryableKiroStreamCatchError, parseKiroStream } from "./kiro/stream";
export { createKiroAdapter } from "./kiro/adapter";
