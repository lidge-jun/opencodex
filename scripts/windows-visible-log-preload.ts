/** Desktop console only: tag severity without dropping the full file transcript. */
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

console.warn = (...args: unknown[]) => {
  // This scalar-only timing event is instrumentation, not an operational warning.
  // Keep it in the transcript, but do not flood the warning-only console.
  let level = "WARN";
  if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("{")) {
    try {
      const row = JSON.parse(args[0]);
      if (!row?.level && !row?.error) {
        if (row?.event === "codex-account-list-timing") level = "INFO";
        // Successful hardening is diagnostics, not a permission failure. Unknown
        // and failed outcomes remain visible; never suppress all ACL events.
        if (row?.event === "management-token-acl-hardening" && row.ok === true && row.errorCode === "none") level = "INFO";
      }
    } catch { /* ordinary warning text */ }
  }
  originalWarn(`[OCX:${level}]`, ...args);
};
console.error = (...args: unknown[]) => {
  // Some CLI notices intentionally use stderr, but explicitly say WARNING.
  // Only recognize a leading marker; an exception mentioning a warning stays red.
  const message = typeof args[0] === "string" ? args[0].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimStart() : "";
  originalError(message.startsWith("WARNING:") ? "[OCX:WARN]" : "[OCX:ERROR]", ...args);
};

// The launcher records the authoritative PID and OS exit status after it has
// drained both pipes. This marker is the child-side counterpart: it confirms
// that ordinary Bun shutdown reached its exit hook without serializing an
// exception, command line, environment, or request data.
process.on("exit", (code) => {
  originalWarn(`[OCX:INFO] child-process-exit code=${code}`);
});
