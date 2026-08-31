/**
 * What `ocx` can do, as data an agent can read without parsing help text.
 *
 * This is the machine-readable index behind `ocx capabilities`. It relates each CLI
 * capability to the management route(s) it drives, which nothing in this repository did
 * before: help lived in twenty per-module `USAGE` constants and a hand-written banner
 * that a test explicitly licensed to drift from the command registry.
 *
 * LEAF MODULE. It imports nothing from `src/cli/`, and nothing here may import a command
 * module. That is not tidiness. Each command module declares its usage text as a
 * top-level `const USAGE`, evaluated at import time, so a cycle back into this table
 * would resolve to `undefined` under ESM rather than throwing -- silently emptying the
 * usage text that `rejectArgs` hands to `CliUsageError`, in the exact error-reporting
 * surface the CLI-operability issues are about. `tests/cli-capabilities.test.ts` asserts
 * the absence of those imports and that every rendered usage string is non-empty, so the
 * failure mode is loud instead of degraded.
 *
 * Head-handled surfaces (`--version`, `help`) are declared separately in
 * `HEAD_CAPABILITIES`. They exit in the CLI head (`root.ts`) before dispatch and have no
 * runner key, so listing them as ordinary capabilities would break the registry parity
 * assertion that every canonical entry is a direct runner. `help` is excluded from
 * `CLI_COMMANDS` deliberately -- `tests/cli-registry.test.ts` documents it as a
 * head-handled pseudo-case -- and that decision is preserved here rather than reversed.
 */

/** A management route a capability drives. Path text only; never a handler reference. */
export interface CapabilityRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
}

export interface CapabilityFlag {
  readonly name: string;
  readonly value?: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly summary: string;
}

/**
 * How a capability emits JSON.
 *
 * - `payload`: the API payload, largely unwrapped.
 * - `envelope`: a CLI-shaped object with its own schema.
 * - `none`: no `--json` mode.
 */
export type CapabilityJsonMode = "payload" | "envelope" | "none";

export interface Capability {
  /** Command path, e.g. `["account", "pause"]`. */
  readonly command: readonly string[];
  readonly summary: string;
  readonly routes: readonly CapabilityRoute[];
  readonly flags: readonly CapabilityFlag[];
  readonly mutates: boolean;
  readonly json: CapabilityJsonMode;
  readonly details?: readonly string[];
  /**
   * Extra banner rows this capability owns, for surfaces the banner shows separately
   * from the bare command (`ocx restore back`, `ocx doctor --reclaim-response-temps`).
   * Without this the banner cannot equal the capability set: it legitimately carries more
   * rows than there are commands.
   */
  readonly bannerLines?: readonly string[];
}

/**
 * Surfaces resolved in the CLI head, before dispatch.
 *
 * They belong in `ocx capabilities` output and in the banner, but not in `CLI_COMMANDS`:
 * `--version`, `-v`, and `version` are answered at `root.ts` and exit, so none of them is
 * a runner key to parity-check against.
 */
export interface HeadCapability {
  readonly invocations: readonly string[];
  readonly summary: string;
  readonly bannerLine: string;
}

export const HEAD_CAPABILITIES: readonly HeadCapability[] = [
  {
    invocations: ["--version", "-v", "version"],
    summary: "Print the CLI version and exit.",
    bannerLine: "ocx --version | -v          Print version",
  },
  {
    invocations: ["help", "--help", "-h"],
    summary: "Print the command list, or one command's usage with `ocx help <command>`.",
    bannerLine: "ocx help [command]          Show help for a command",
  },
];

/**
 * Capabilities declared so far. Incomplete by design: later phases add verbs.
 * `ocx capabilities` is the index of what is listed here, not of every CLI command.
 * A capability must not name a route the command does not actually fetch.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    command: ["status"],
    summary: "Proxy status, injection state, and version skew between this CLI and the running proxy.",
    // No management route: `collectStatus` identity-probes `/healthz` through
    // `findLiveProxy` and reads local config. Declaring `GET /api/status` here was wrong
    // -- that route does not exist, and the registry cross-check caught it.
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the status envelope as JSON." }],
    mutates: false,
    json: "envelope",
    details: ["Reads /healthz plus local config; drives no management API route."],
  },
  {
    command: ["capabilities"],
    summary: "List the declared CLI capabilities and the management routes they drive.",
    routes: [],
    flags: [
      { name: "--json", value: "boolean", summary: "Emit the full capability table as JSON." },
      { name: "--mutating-only", value: "boolean", summary: "Restrict output to capabilities that mutate state." },
      { name: "--route", value: "string", summary: "Show which capabilities drive a management route." },
    ],
    mutates: false,
    json: "envelope",
    details: ["Start here when driving ocx programmatically: it is the declared surface index, not a complete verb list."],
  },
  {
    command: ["provider", "list"],
    summary: "Configured providers with connectivity and selected models.",
    // Local config + PROVIDER_REGISTRY. Does not call GET /api/providers.
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the provider list as JSON." }],
    mutates: false,
    json: "envelope",
    details: ["Reads local config; drives no management API route."],
  },
  {
    command: ["account", "list"],
    summary: "Codex OAuth accounts with pool priority and pause state.",
    routes: [{ method: "GET", path: "/api/codex-auth/accounts" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the account list as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "STATUS names `paused` alongside `selected`: a paused-but-selected account still receives requests.",
      "`--quota` shows cached Codex windows (including 5h); `--refresh` bypasses the server TTL.",
    ],
  },
  {
    command: ["usage"],
    summary: "Token and estimated-cost report over a time range.",
    routes: [{ method: "GET", path: "/api/usage" }],
    flags: [
      { name: "--range", value: "string", summary: "today | 1d | 7d | 30d | all" },
      { name: "--provider", value: "string", summary: "Restrict to one provider." },
      { name: "--model", value: "string", summary: "Restrict to one model id." },
      { name: "--json", value: "boolean", summary: "Emit the usage report as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: [
      "Per-account totals are withheld under `--provider` or `--model`: account rows cannot be honestly re-partitioned by provider, so the report says so rather than printing an empty table.",
      "An `(ambiguous)` account row aggregates several accounts; do not read it as one identity.",
    ],
  },
  {
    command: ["account", "pause"],
    summary: "Stop routing new requests to one account in the Codex pool.",
    // One route, both directions: `resume` is the same PUT with `paused: false`.
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the pause result as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "Pausing also unbinds threads pinned to the account and selects a fallback if it was active -- side effects of the route, not of the word `pause`.",
      "The issue that requested this reported the route as POST; it is PUT.",
    ],
  },
  {
    command: ["account", "resume"],
    summary: "Return a paused account to the Codex pool.",
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the resume result as JSON." }],
    mutates: true,
    json: "envelope",
  },
  {
    command: ["account", "pause-exhausted"],
    summary: "Pause every Codex account whose quota is spent.",
    routes: [{ method: "PUT", path: "/api/codex-auth/accounts/pause-exhausted" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit paused ids and the checked/failed counts as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "The route refreshes quota per account and can partially fail; a non-zero failed count exits 1 and sets ok:false, because silence would read as `none were exhausted`.",
    ],
  },
  {
    command: ["account", "strategy"],
    summary: "Show or set how an account pool picks the next account.",
    // Both pools, because both have the setting. The Codex pool reads its applied values
    // from the active payload; the Anthropic pool has its own GET.
    routes: [
      { method: "GET", path: "/api/codex-auth/active" },
      { method: "PUT", path: "/api/codex-auth/pool-strategy" },
      { method: "GET", path: "/api/oauth/accounts/pool" },
      { method: "PUT", path: "/api/oauth/accounts/pool" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON." }],
    mutates: true,
    json: "envelope",
    details: [
      "A bare invocation reads and never writes.",
      "The APPLIED value is echoed, not the requested one, so a server-side normalization stays visible.",
      "Values are not re-validated in the CLI: the server owns the strategy names and the 1-100 sticky bound.",
      "`anthropic` is the only OAuth pool with this setting; other OAuth providers are refused without a round-trip.",
    ],
  },
  {
    command: ["account", "sticky"],
    summary: "Show or set how many consecutive requests stay on one account.",
    routes: [
      { method: "GET", path: "/api/codex-auth/active" },
      { method: "PUT", path: "/api/codex-auth/pool-strategy" },
      { method: "GET", path: "/api/oauth/accounts/pool" },
      { method: "PUT", path: "/api/oauth/accounts/pool" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON." }],
    mutates: true,
    json: "envelope",
    details: ["Only meaningful under the sticky-capable strategies; the pool strategy is the other half of this setting."],
  },
  {
    command: ["logs"],
    summary: "Recent request log rows, filterable by provider, model, conversation, and status.",
    routes: [{ method: "GET", path: "/api/logs" }],
    flags: [
      { name: "--provider", value: "string", summary: "Restrict to one provider, matching failover attempts too." },
      { name: "--model", value: "string", summary: "Restrict to one model id, matching failover attempts too." },
      { name: "--conversation", value: "string", summary: "Restrict to one conversation id (`--conversationId` is accepted too)." },
      { name: "--status", value: "string", summary: "An exact code (429) or a class (5xx)." },
      { name: "--limit", value: "number", summary: "Row cap; defaults to 200." },
      { name: "--follow", value: "boolean", summary: "Stream new rows as JSONL; implies --jsonl." },
      { name: "--json", value: "boolean", summary: "Emit the server payload as JSON." },
      { name: "--jsonl", value: "boolean", summary: "Emit one row per line." },
    ],
    mutates: false,
    json: "payload",
    details: [
      "`--provider` and `--model` both match a failover attempt, so a request is findable by what actually served it, not only by what was asked for.",
      "Rows print `conv=<id>` when the entry carries one, so a conversation filter can be told apart from an empty result.",
      "`--follow` deduplicates by row id and cannot be combined with `--json`.",
    ],
  },
  {
    command: ["storage", "report"],
    summary: "Disk usage under CODEX_HOME, with the log-guard protection report.",
    routes: [{ method: "GET", path: "/api/storage" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the storage report as JSON." }],
    mutates: false,
    json: "payload",
    bannerLines: ["ocx storage                 Storage report (default subcommand)"],
  },
  {
    command: ["storage", "cleanup"],
    summary: "Preview or delete the oldest archived sessions by percentage.",
    // Both routes, because the verb always previews: the mutating route requires the digest the
    // preview returns and rejects a stale one, so the two are one operation.
    routes: [
      { method: "POST", path: "/api/storage/cleanup/preview" },
      { method: "POST", path: "/api/storage/cleanup" },
    ],
    flags: [
      { name: "--percent", value: "number", summary: "Portion of the oldest archived sessions to target (0-100)." },
      { name: "--mode", value: "string", summary: "quarantine (recoverable from trash) or permanent." },
      { name: "--yes", value: "boolean", summary: "Required to actually delete; without it this is a preview." },
      { name: "--json", value: "boolean", summary: "Emit the preview or result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "Without `--yes` it prints what WOULD be freed and exits 0 having changed nothing.",
      "There is no interactive confirmation: a prompt an agent can answer is not a safety boundary.",
      "`--mode quarantine` moves files to trash, so `storage trash restore` can undo it; `permanent` cannot be undone.",
    ],
  },
  {
    command: ["storage", "trash"],
    summary: "List quarantined cleanup batches, or restore one.",
    routes: [
      { method: "GET", path: "/api/storage/trash" },
      { method: "POST", path: "/api/storage/trash/restore" },
    ],
    flags: [
      { name: "--yes", value: "boolean", summary: "Required for restore, which moves files and reconciles database rows." },
      { name: "--json", value: "boolean", summary: "Emit the trash list or restore result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: ["Restore fails with a named 409 when the destination already exists, rather than overwriting it."],
  },
  {
    command: ["storage", "policy"],
    summary: "Show, change, or run the automatic archived-session cleanup policy.",
    routes: [
      { method: "GET", path: "/api/storage/cleanup-policy" },
      { method: "PUT", path: "/api/storage/cleanup-policy" },
      { method: "POST", path: "/api/storage/cleanup-policy/run" },
    ],
    flags: [
      { name: "--enabled", value: "string", summary: "true or false." },
      { name: "--percent", value: "number", summary: "Portion of oldest archived sessions each run targets." },
      { name: "--mode", value: "string", summary: "quarantine or permanent." },
      { name: "--schedule", value: "string", summary: "startup, daily, weekly, or manual." },
      { name: "--yes", value: "boolean", summary: "Required for `policy run`, which deletes immediately." },
      { name: "--json", value: "boolean", summary: "Emit the policy or run state as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "`policy set` never enables implicitly: omitting `--enabled` keeps the stored value.",
      "`policy run` forces a run regardless of schedule, so it needs `--yes`.",
    ],
  },
  {
    command: ["inspect", "config"],
    summary: "The effective merged configuration the proxy is running.",
    routes: [{ method: "GET", path: "/api/config" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the config as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "catalog"],
    summary: "The generated model catalog served to clients.",
    routes: [{ method: "GET", path: "/api/catalog" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the catalog as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "routing-analytics"],
    summary: "Aggregate routing outcomes per provider and model.",
    routes: [{ method: "GET", path: "/api/routing-analytics" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the analytics payload as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "pacing"],
    summary: "Request-pacing state for one provider or all of them.",
    routes: [{ method: "GET", path: "/api/provider-request-pacing" }],
    flags: [
      { name: "--name", value: "string", summary: "Restrict to one provider; omitted means every provider." },
      { name: "--json", value: "boolean", summary: "Emit the pacing state as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: ["An unknown provider name is a 404 rather than an empty result."],
  },
  {
    command: ["inspect", "key-providers"],
    summary: "Providers that authenticate with an API key rather than OAuth.",
    routes: [{ method: "GET", path: "/api/key-providers" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the provider list as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "codex-prompt"],
    summary: "The Codex system prompt state, or the prompt text itself.",
    routes: [
      { method: "GET", path: "/api/codex-prompt" },
      { method: "GET", path: "/api/codex-prompt/text" },
    ],
    flags: [
      { name: "--text", value: "boolean", summary: "Print the prompt body verbatim instead of its metadata." },
      { name: "--json", value: "boolean", summary: "Emit the prompt metadata as JSON." },
    ],
    mutates: false,
    json: "payload",
    details: ["Read-only by design: the six mutating prompt routes require a dashboard session."],
  },
  {
    command: ["inspect", "client-config"],
    summary: "The generated configuration snippet for a supported client.",
    routes: [{ method: "GET", path: "/api/client-config" }],
    flags: [
      { name: "--client", value: "string", summary: "Required client id; the route names every accepted value on error." },
      { name: "--json", value: "boolean", summary: "Emit the snippet payload as JSON." },
    ],
    mutates: false,
    json: "payload",
  },
  {
    command: ["inspect", "star"],
    summary: "Whether this repository is starred by the signed-in GitHub account.",
    // GET only, permanently. The POST spends the operator identity and requires a dashboard
    // session precisely so an agent cannot answer that question for them.
    routes: [{ method: "GET", path: "/api/github/star" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the star status as JSON." }],
    mutates: false,
    json: "payload",
    details: ["Starring is never available from the CLI; the verb says so rather than offering a flag that cannot work."],
  },
  {
    command: ["inspect", "windows-tray"],
    summary: "Windows tray helper state.",
    routes: [{ method: "GET", path: "/api/windows-tray" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the tray state as JSON." }],
    mutates: false,
    json: "payload",
  },
  {
    command: ["system", "codex-app-server"],
    summary: "Codex app-server reachability and process state, as the dashboard sees it.",
    routes: [{ method: "GET", path: "/api/system/codex-app-server" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the app-server state as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "The GUI reads this state directly; without a verb an agent could not tell whether the Codex app-server was reachable at all.",
    ],
  },
  {
    command: ["system", "codex-cli-update", "check"],
    summary: "Inspect a configured Codex CLI candidate and its ownership provenance.",
    routes: [],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the redacted provenance report as JSON." }],
    mutates: false,
    json: "envelope",
    details: [
      "Proof-bound published-launcher context authenticates the configured candidate snapshot, not successful Codex execution; this check does not attest or admit a selected runtime.",
      "On Windows this first slice performs no candidate or configuration filesystem I/O: only a proof-captured absolute environment candidate can receive lexical app-bundle or version-manager labels; every other Windows candidate fails closed.",
      "Makes no package-registry request.",
      "Does not execute Codex or npm, install or repair software, control a process, or write configuration or cache state.",
    ],
  },
  {
    command: ["system", "codex-restart"],
    summary: "Restart the Codex app-server.",
    routes: [{ method: "POST", path: "/api/system/codex-restart" }],
    flags: [
      { name: "--yes", value: "boolean", summary: "Required: restarts the operator's running Codex app-server." },
      { name: "--json", value: "boolean", summary: "Emit the restart result as JSON." },
    ],
    mutates: true,
    json: "payload",
    details: [
      "`sync --restart-codex` is not a substitute: it restarts only as a side effect after a catalog or cache write, so it cannot restart a healthy install on request.",
      "--yes is mandatory because this interrupts a running editor session, which must never happen because an agent guessed a subcommand.",
    ],
  },
  {
    command: ["claude", "desktop", "status"],
    summary: "Applied-vs-desired Claude Desktop state, including staleness, drift, and health.",
    routes: [{ method: "GET", path: "/api/claude-desktop/status" }],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the live status as JSON." }],
    mutates: false,
    json: "payload",
    details: [
      "Distinct from `claude desktop show`, which reports what this machine WOULD write; this reports what is actually in effect, which only the running proxy knows.",
    ],
  },
  {
    command: ["integration", "native"],
    summary: "Show or toggle the native Claude, Claude Desktop, Codex, and Grok integrations.",
    routes: [
      { method: "GET", path: "/api/native-integrations" },
      { method: "PUT", path: "/api/native-integrations/claude" },
      { method: "PUT", path: "/api/native-integrations/claude-desktop" },
      { method: "PUT", path: "/api/native-integrations/codex" },
      { method: "PUT", path: "/api/native-integrations/grok" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the client rows or toggle result as JSON." }],
    mutates: true,
    json: "payload",
    details: [
      "The list renders per-client state, installed, and desired columns; a blocked disable is named rather than left silent.",
      "Each client has its own route because a toggle rewrites that client's own config file.",
    ],
  },
  {
    command: ["agent", "request-user-input"],
    summary: "Show or set whether default mode may ask the operator a question mid-task.",
    routes: [
      { method: "GET", path: "/api/codex-auth/features/default-mode-request-user-input" },
      { method: "PUT", path: "/api/codex-auth/features/default-mode-request-user-input" },
    ],
    flags: [{ name: "--json", value: "boolean", summary: "Emit the feature state as JSON." }],
    mutates: true,
    json: "payload",
    details: ["A bare invocation reads and never writes."],
  },
];

/** Capabilities that drive `route`, for `ocx capabilities --route`. */
export function capabilitiesForRoute(path: string): Capability[] {
  return CAPABILITIES.filter(cap => cap.routes.some(r => r.path === path));
}

/** Every `(method, path)` pair any capability drives. */
export function capabilityRouteKeys(): Set<string> {
  const keys = new Set<string>();
  for (const cap of CAPABILITIES) {
    for (const route of cap.routes) keys.add(`${route.method} ${route.path}`);
  }
  return keys;
}

/** Rendered command path, e.g. `ocx account pause`. */
export function capabilityInvocation(cap: Capability): string {
  return `ocx ${cap.command.join(" ")}`;
}
