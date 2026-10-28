/** Credential authorization is deliberately narrower than Codex's evolving CLI. */
export const CODEX_TOKEN_SAFE_SWITCHES = [
  "--no-daemon", "--json", "--ephemeral", "--skip-git-repo-check",
  "--no-alt-screen", "--full-auto", "--dangerously-bypass-approvals-and-sandbox", "--search",
] as const;
export const CODEX_TOKEN_SAFE_VALUE_FLAGS = ["--model", "-m", "--sandbox", "-s", "--ask-for-approval", "-a", "--image", "-i"] as const;

export function codexTokenArgsAreSafe(args: readonly string[]): boolean {
  let command = "interactive", operands = 0, afterSeparator = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" && !afterSeparator) { afterSeparator = true; continue; }
    if (arg.startsWith("-") && arg !== "-") {
      if (afterSeparator) return false;
      if ((CODEX_TOKEN_SAFE_SWITCHES as readonly string[]).includes(arg)) continue;
      const equals = arg.indexOf("="), flag = equals < 0 ? arg : arg.slice(0, equals);
      if (!(CODEX_TOKEN_SAFE_VALUE_FLAGS as readonly string[]).includes(flag)) return false;
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
      if (!value || value.startsWith("-")) return false;
      if (["--sandbox", "-s"].includes(flag) && !["read-only", "workspace-write", "danger-full-access"].includes(value)) return false;
      if (["--ask-for-approval", "-a"].includes(flag) && !["untrusted", "on-failure", "on-request", "never"].includes(value)) return false;
      continue;
    }
    // Restored sessions may restore a different cwd/provider. They need a separate proof.
    if (!afterSeparator && operands === 0 && ["resume", "fork", "review", "app", "app-server", "mcp", "mcp-server", "cloud", "apply", "completion", "debug", "features", "sandbox", "login", "logout", "help", "update", "doctor", "e"].includes(arg)) return false;
    if (!afterSeparator && command === "interactive" && operands === 0 && arg === "exec") {
      command = arg; continue;
    }
    // A single-word operand can become a subcommand after a native-client upgrade.
    // Require an explicit separator for such prompts; whitespace cannot name a subcommand.
    if (!afterSeparator && arg !== "-" && !/\s/.test(arg)) return false;
    operands++;
    if (operands > 1) return false;
  }
  return true;
}

// Unknown configuration may introduce a command helper, hook, or new credential consumer.
// Keep this independent from the provider's exact generated-block comparison.
export const CODEX_TOKEN_SAFE_CONFIG_KEYS = [
  "model_provider", "model_providers", "model", "model_reasoning_effort", "model_reasoning_summary",
  "model_verbosity", "approval_policy", "sandbox_mode", "openai_base_url", "features",
] as const;

export function codexTokenConfigShapeIsSafe(config: Record<string, unknown>): boolean {
  if (Object.keys(config).some(key => !(CODEX_TOKEN_SAFE_CONFIG_KEYS as readonly string[]).includes(key))) return false;
  const providers = config.model_providers;
  if (!providers || typeof providers !== "object" || Object.keys(providers).some(key => key !== "opencodex")) return false;
  for (const [key, value] of Object.entries(config)) {
    if (["features", "model_providers"].includes(key)) continue;
    if (typeof value !== "string") return false;
  }
  const features = config.features;
  if (features !== undefined && (!features || typeof features !== "object" || Array.isArray(features)
    || Object.entries(features).some(([key, value]) => key === "respect_system_proxy" ? value !== false
      : key !== "system_proxy_fallback" || typeof value !== "boolean")
    || ("system_proxy_fallback" in features && (!("respect_system_proxy" in features) || features.respect_system_proxy !== false)))) return false;
  return true;
}

/** Unknown Codex/OpenAI environment controls need an audit before receiving a fresh secret. */
export function codexTokenEnvironmentIsSafe(env: Record<string, string | undefined>): boolean {
  return !Object.entries(env).some(([key, value]) => {
    if (!value) return false;
    if (/^(?:https?|all)_proxy$/i.test(key)) return true;
    if (/^(?:CODEX_|OPENAI_|AZURE_OPENAI_)/i.test(key) && key !== "CODEX_HOME") return true;
    return key !== "OPENCODEX_API_AUTH_TOKEN" && key.toUpperCase() === "OPENCODEX_API_AUTH_TOKEN";
  });
}

/** Check even unselected profiles/providers; new credential field names fail closed. */
export function codexHasOtherTokenConsumers(config: Record<string, unknown>): boolean {
  function visit(value: unknown): boolean {
    if (typeof value === "string") return value.toUpperCase().includes("OPENCODEX_API_AUTH_TOKEN");
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) =>
      key.toUpperCase().includes("OPENCODEX_API_AUTH_TOKEN")
      // A stdio MCP process can inherit the environment without naming the variable.
      || (key === "mcp_servers" && child !== null && typeof child === "object" && Object.keys(child).length > 0)
      || visit(child));
  }
  const providers = config.model_providers as Record<string, unknown> | undefined;
  return visit({ ...config, model_providers: { ...providers, opencodex: undefined } });
}
