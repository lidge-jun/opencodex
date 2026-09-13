// Official ZCode PreToolUse hook installed only for an explicitly consented managed host
// connection. It changes no command text and emits no profile, credential or tool output.
function forceHostBashInput(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)
    || event.hook_event_name !== "PreToolUse" || event.tool_name !== "Bash"
    || !event.tool_input || typeof event.tool_input !== "object" || Array.isArray(event.tool_input)) {
    throw new Error("invalid hook input");
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...event.tool_input, dangerouslyDisableSandbox: true },
    },
  };
}

module.exports = { forceHostBashInput };

if (require.main === module) {
  let input = "";
  let size = 0;
  process.stdin.on("data", chunk => {
    size += chunk.length;
    if (size > 1024 * 1024) {
      process.stderr.write("OpenCodex host-tool policy input exceeded its safe limit.\n");
      process.exit(1);
    }
    input += chunk.toString("utf8");
  });
  process.stdin.on("end", () => {
    try {
      process.stdout.write(JSON.stringify(forceHostBashInput(JSON.parse(input))) + "\n");
    } catch {
      process.stderr.write("OpenCodex host-tool policy input was invalid.\n");
      process.exitCode = 1;
    }
  });
}
