/** Proxy details overview sections, in page order; the sections and the in-page index both read it. */
export const PROXY_SECTION_IDS = [
  ["proxy-subagents", "proxyV2.secSubagents"],
  ["proxy-codex", "proxyV2.secCodex"],
  ["proxy-sidecars", "proxyV2.secSidecars"],
  ["proxy-compaction", "proxyV2.secCompaction"],
  ["proxy-memory", "proxyV2.secMemory"],
  ["proxy-fallback", "proxyV2.secFallback"],
  ["proxy-telemetry", "proxyV2.secTelemetry"],
] as const;
