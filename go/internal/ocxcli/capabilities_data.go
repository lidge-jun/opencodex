package ocxcli

// Code generated from src/cli/capabilities.ts by the issue-46 flip; keep in
// lockstep with the TypeScript capability table (the parity oracle diffs the
// TS CLI against this data at runtime).

// capabilityRoute is one management route a capability drives.
type capabilityRoute struct{ method, path string }

type capabilityFlag struct {
	name     string
	value    string // "" when the flag takes no value; else "string"|"number"|"boolean"
	required bool
	summary  string
}

type capability struct {
	command []string
	summary string
	routes  []capabilityRoute
	flags   []capabilityFlag
	mutates bool
	json    string // "payload" | "envelope" | "none"
	details []string
}

type headCapability struct {
	invocations []string
	summary     string
	bannerLine  string
}

// capabilitiesTable mirrors CAPABILITIES in src/cli/capabilities.ts, in order.
var capabilitiesTable = []capability{
	{
		command: []string{"status"},
		summary: "Proxy status, injection state, and version skew between this CLI and the running proxy.",
		routes:  []capabilityRoute{},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the status envelope as JSON."},
		},
		mutates: false,
		json:    "envelope",
		details: []string{"Reads /healthz plus local config; drives no management API route."},
	},
	{
		command: []string{"connect", "rotate"},
		summary: "Rotate the connected client's data key against the hub, with commit and abort.",
		routes: []capabilityRoute{
			{method: "POST", path: "/api/keys/rotate"},
			{method: "POST", path: "/api/keys/rotate/commit"},
			{method: "DELETE", path: "/api/keys/rotate"},
		},
		flags: []capabilityFlag{
			{name: "--pairing-code-stdin", value: "boolean", summary: "Read a one-time pairing code from stdin as the rotation authority."},
			{name: "--admin-token-stdin", value: "boolean", summary: "Read the hub admin token from stdin as the rotation authority."},
			{name: "--json", value: "boolean", summary: "Emit the rotation result as JSON."},
		},
		mutates: true,
		json:    "payload",
		details: []string{"Requires transient authority on stdin; the credential is never persisted or echoed.", "A rotation left pending by a crash is resumed here — startup and status stop rather than guess which key generation is live."},
	},
	{
		command: []string{"capabilities"},
		summary: "List the declared CLI capabilities and the management routes they drive.",
		routes:  []capabilityRoute{},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the full capability table as JSON."},
			{name: "--mutating-only", value: "boolean", summary: "Restrict output to capabilities that mutate state."},
			{name: "--route", value: "string", summary: "Show which capabilities drive a management route."},
		},
		mutates: false,
		json:    "envelope",
		details: []string{"Start here when driving ocx programmatically: it is the declared surface index, not a complete verb list."},
	},
	{
		command: []string{"provider", "list"},
		summary: "Configured providers with connectivity and selected models.",
		routes:  []capabilityRoute{},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the provider list as JSON."},
		},
		mutates: false,
		json:    "envelope",
		details: []string{"Reads local config; drives no management API route."},
	},
	{
		command: []string{"provider", "keychain"},
		summary: "Move a provider's API key into the OS keychain, restore it, or report where it lives.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/providers/keychain"},
			{method: "POST", path: "/api/providers/keychain"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the keychain status or result as JSON."},
		},
		mutates: true,
		json:    "payload",
		details: []string{"`store` verifies every keychain write by read-back before config.json is rewritten with keychain: references; an unavailable keychain refuses with 503 and leaves the file untouched.", "Headless services usually have no unlocked keychain session; prefer ${ENV_VAR} references there."},
	},
	{
		command: []string{"account", "list"},
		summary: "Codex OAuth accounts with pool priority and pause state.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/codex-auth/accounts"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the account list as JSON."},
		},
		mutates: false,
		json:    "payload",
		details: []string{"STATUS names `paused` alongside `selected`: a paused-but-selected account still receives requests.", "`--quota` shows cached Codex windows (including 5h); `--refresh` bypasses the server TTL."},
	},
	{
		command: []string{"usage"},
		summary: "Token and estimated-cost report over a time range.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/usage"},
		},
		flags: []capabilityFlag{
			{name: "--range", value: "string", summary: "today | 1d | 7d | 30d | all"},
			{name: "--provider", value: "string", summary: "Restrict to one provider."},
			{name: "--model", value: "string", summary: "Restrict to one model id."},
			{name: "--json", value: "boolean", summary: "Emit the usage report as JSON."},
		},
		mutates: false,
		json:    "payload",
		details: []string{"Per-account totals are withheld under `--provider` or `--model`: account rows cannot be honestly re-partitioned by provider, so the report says so rather than printing an empty table.", "An `(ambiguous)` account row aggregates several accounts; do not read it as one identity."},
	},
	{
		command: []string{"account", "pause"},
		summary: "Stop routing new requests to one account in the Codex pool.",
		routes: []capabilityRoute{
			{method: "PUT", path: "/api/codex-auth/accounts/pause"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the pause result as JSON."},
		},
		mutates: true,
		json:    "envelope",
		details: []string{"Pausing also unbinds threads pinned to the account and selects a fallback if it was active -- side effects of the route, not of the word `pause`.", "The issue that requested this reported the route as POST; it is PUT."},
	},
	{
		command: []string{"account", "resume"},
		summary: "Return a paused account to the Codex pool.",
		routes: []capabilityRoute{
			{method: "PUT", path: "/api/codex-auth/accounts/pause"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the resume result as JSON."},
		},
		mutates: true,
		json:    "envelope",
	},
	{
		command: []string{"account", "pause-exhausted"},
		summary: "Pause every Codex account whose quota is spent.",
		routes: []capabilityRoute{
			{method: "PUT", path: "/api/codex-auth/accounts/pause-exhausted"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit paused ids and the checked/failed counts as JSON."},
		},
		mutates: true,
		json:    "envelope",
		details: []string{"The route refreshes quota per account and can partially fail; a non-zero failed count exits 1 and sets ok:false, because silence would read as `none were exhausted`."},
	},
	{
		command: []string{"account", "strategy"},
		summary: "Show or set how an account pool picks the next account.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/codex-auth/active"},
			{method: "PUT", path: "/api/codex-auth/pool-strategy"},
			{method: "GET", path: "/api/oauth/accounts/pool"},
			{method: "PUT", path: "/api/oauth/accounts/pool"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON."},
		},
		mutates: true,
		json:    "envelope",
		details: []string{"A bare invocation reads and never writes.", "The APPLIED value is echoed, not the requested one, so a server-side normalization stays visible.", "Values are not re-validated in the CLI: the server owns the strategy names and the 1-100 sticky bound.", "`anthropic` owns the full pool contract. Other OAuth providers reach the same endpoint with a generic subset (enabled/strategy/autoSwitchThreshold) whose settings persist but do not yet steer selection; `sticky` and `quotaWindow` are refused for them."},
	},
	{
		command: []string{"account", "sticky"},
		summary: "Show or set how many consecutive requests stay on one account.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/codex-auth/active"},
			{method: "PUT", path: "/api/codex-auth/pool-strategy"},
			{method: "GET", path: "/api/oauth/accounts/pool"},
			{method: "PUT", path: "/api/oauth/accounts/pool"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the applied strategy and sticky limit as JSON."},
		},
		mutates: true,
		json:    "envelope",
		details: []string{"Only meaningful under the sticky-capable strategies; the pool strategy is the other half of this setting."},
	},
	{
		command: []string{"logs"},
		summary: "Recent request log rows, filterable by provider, model, conversation, and status.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/logs"},
		},
		flags: []capabilityFlag{
			{name: "--provider", value: "string", summary: "Restrict to one provider, matching failover attempts too."},
			{name: "--model", value: "string", summary: "Restrict to one model id, matching failover attempts too."},
			{name: "--conversation", value: "string", summary: "Restrict to one conversation id (`--conversationId` is accepted too)."},
			{name: "--status", value: "string", summary: "An exact code (429) or a class (5xx)."},
			{name: "--limit", value: "number", summary: "Row cap; defaults to 200."},
			{name: "--follow", value: "boolean", summary: "Poll for new rows; add --jsonl to emit JSONL."},
			{name: "--json", value: "boolean", summary: "Emit the server payload as JSON."},
			{name: "--jsonl", value: "boolean", summary: "Emit one row per line."},
		},
		mutates: false,
		json:    "payload",
		details: []string{"`--provider` and `--model` both match a failover attempt, so a request is findable by what actually served it, not only by what was asked for.", "Rows print `conv=<id>` when the entry carries one, so a conversation filter can be told apart from an empty result.", "`--follow` deduplicates by row id and cannot be combined with `--json`."},
	},
	{
		command: []string{"storage", "report"},
		summary: "Disk usage under CODEX_HOME, with the log-guard protection report.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/storage"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the storage report as JSON."},
		},
		mutates: false,
		json:    "payload",
	},
	{
		command: []string{"storage", "cleanup"},
		summary: "Preview or delete the oldest archived sessions by percentage.",
		routes: []capabilityRoute{
			{method: "POST", path: "/api/storage/cleanup/preview"},
			{method: "POST", path: "/api/storage/cleanup"},
		},
		flags: []capabilityFlag{
			{name: "--percent", value: "number", summary: "Portion of the oldest archived sessions to target (0-100)."},
			{name: "--mode", value: "string", summary: "quarantine (recoverable from trash) or permanent."},
			{name: "--yes", value: "boolean", summary: "Required to actually delete; without it this is a preview."},
			{name: "--json", value: "boolean", summary: "Emit the preview or result as JSON."},
		},
		mutates: true,
		json:    "payload",
		details: []string{"Without `--yes` it prints what WOULD be freed and exits 0 having changed nothing.", "There is no interactive confirmation: a prompt an agent can answer is not a safety boundary.", "`--mode quarantine` moves files to trash, so `storage trash restore` can undo it; `permanent` cannot be undone."},
	},
	{
		command: []string{"storage", "trash"},
		summary: "List quarantined cleanup batches, or restore one.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/storage/trash"},
			{method: "POST", path: "/api/storage/trash/restore"},
		},
		flags: []capabilityFlag{
			{name: "--yes", value: "boolean", summary: "Required for restore, which moves files and reconciles database rows."},
			{name: "--json", value: "boolean", summary: "Emit the trash list or restore result as JSON."},
		},
		mutates: true,
		json:    "payload",
		details: []string{"Restore fails with a named 409 when the destination already exists, rather than overwriting it."},
	},
	{
		command: []string{"storage", "policy"},
		summary: "Show, change, or run the automatic archived-session cleanup policy.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/storage/cleanup-policy"},
			{method: "PUT", path: "/api/storage/cleanup-policy"},
			{method: "POST", path: "/api/storage/cleanup-policy/run"},
		},
		flags: []capabilityFlag{
			{name: "--enabled", value: "string", summary: "true or false."},
			{name: "--percent", value: "number", summary: "Portion of oldest archived sessions each run targets."},
			{name: "--mode", value: "string", summary: "quarantine or permanent."},
			{name: "--schedule", value: "string", summary: "startup, daily, weekly, or manual."},
			{name: "--yes", value: "boolean", summary: "Required for `policy run`, which deletes immediately."},
			{name: "--json", value: "boolean", summary: "Emit the policy or run state as JSON."},
		},
		mutates: true,
		json:    "payload",
		details: []string{"`policy set` never enables implicitly: omitting `--enabled` keeps the stored value.", "`policy run` forces a run regardless of schedule, so it needs `--yes`."},
	},
	{
		command: []string{"inspect", "config"},
		summary: "The effective merged configuration the proxy is running.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/config"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the config as JSON."},
		},
		mutates: false,
		json:    "payload",
	},
	{
		command: []string{"inspect", "catalog"},
		summary: "The generated model catalog served to clients.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/catalog"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the catalog as JSON."},
		},
		mutates: false,
		json:    "payload",
	},
	{
		command: []string{"inspect", "routing-analytics"},
		summary: "Aggregate routing outcomes per provider and model.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/routing-analytics"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the analytics payload as JSON."},
		},
		mutates: false,
		json:    "payload",
	},
	{
		command: []string{"inspect", "pacing"},
		summary: "Request-pacing state for one provider or all of them.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/provider-request-pacing"},
		},
		flags: []capabilityFlag{
			{name: "--name", value: "string", summary: "Restrict to one provider; omitted means every provider."},
			{name: "--json", value: "boolean", summary: "Emit the pacing state as JSON."},
		},
		mutates: false,
		json:    "payload",
		details: []string{"An unknown provider name is a 404 rather than an empty result."},
	},
	{
		command: []string{"inspect", "key-providers"},
		summary: "Providers that authenticate with an API key rather than OAuth.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/key-providers"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the provider list as JSON."},
		},
		mutates: false,
		json:    "payload",
	},
	{
		command: []string{"inspect", "codex-prompt"},
		summary: "The Codex system prompt state, or the prompt text itself.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/codex-prompt"},
			{method: "GET", path: "/api/codex-prompt/text"},
		},
		flags: []capabilityFlag{
			{name: "--text", value: "boolean", summary: "Print the prompt body verbatim instead of its metadata."},
			{name: "--json", value: "boolean", summary: "Emit the prompt metadata as JSON."},
		},
		mutates: false,
		json:    "payload",
		details: []string{"Read-only by design: the six mutating prompt routes require a dashboard session."},
	},
	{
		command: []string{"inspect", "client-config"},
		summary: "The generated configuration snippet for a supported client.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/client-config"},
		},
		flags: []capabilityFlag{
			{name: "--client", value: "string", summary: "Required client id; the route names every accepted value on error."},
			{name: "--json", value: "boolean", summary: "Emit the snippet payload as JSON."},
		},
		mutates: false,
		json:    "payload",
	},
	{
		command: []string{"inspect", "star"},
		summary: "Whether this repository is starred by the signed-in GitHub account.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/github/star"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the star status as JSON."},
		},
		mutates: false,
		json:    "payload",
		details: []string{"Starring is never available from the CLI; the verb says so rather than offering a flag that cannot work."},
	},
	{
		command: []string{"inspect", "windows-tray"},
		summary: "Windows tray helper state.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/windows-tray"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the tray state as JSON."},
		},
		mutates: false,
		json:    "payload",
	},
	{
		command: []string{"system", "codex-app-server"},
		summary: "Codex app-server reachability and process state, as the dashboard sees it.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/system/codex-app-server"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the app-server state as JSON."},
		},
		mutates: false,
		json:    "payload",
		details: []string{"The GUI reads this state directly; without a verb an agent could not tell whether the Codex app-server was reachable at all."},
	},
	{
		command: []string{"system", "codex-cli-update", "check"},
		summary: "Inspect a configured Codex CLI candidate and its ownership provenance.",
		routes:  []capabilityRoute{},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the redacted provenance report as JSON."},
		},
		mutates: false,
		json:    "envelope",
		details: []string{"Proof-bound published-launcher context authenticates the configured candidate snapshot, not successful Codex execution; this check does not attest or admit a selected runtime.", "On Windows this first slice performs no candidate or configuration filesystem I/O: only a proof-captured absolute environment candidate can receive lexical app-bundle or version-manager labels; every other Windows candidate fails closed.", "Makes no package-registry request.", "Does not execute Codex or npm, install or repair software, control a process, or write configuration or cache state."},
	},
	{
		command: []string{"system", "codex-restart"},
		summary: "Restart the Codex app-server.",
		routes: []capabilityRoute{
			{method: "POST", path: "/api/system/codex-restart"},
		},
		flags: []capabilityFlag{
			{name: "--yes", value: "boolean", summary: "Required: restarts the operator's running Codex app-server."},
			{name: "--json", value: "boolean", summary: "Emit the restart result as JSON."},
		},
		mutates: true,
		json:    "payload",
		details: []string{"`sync --restart-codex` is not a substitute: it restarts only as a side effect after a catalog or cache write, so it cannot restart a healthy install on request.", "--yes is mandatory because this interrupts a running editor session, which must never happen because an agent guessed a subcommand."},
	},
	{
		command: []string{"claude", "desktop", "status"},
		summary: "Applied-vs-desired Claude Desktop state, including staleness, drift, and health.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/claude-desktop/status"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the live status as JSON."},
		},
		mutates: false,
		json:    "payload",
		details: []string{"Distinct from `claude desktop show`, which reports what this machine WOULD write; this reports what is actually in effect, which only the running proxy knows."},
	},
	{
		command: []string{"integration", "native"},
		summary: "Show or toggle the native Claude, Claude Desktop, Codex, and Grok integrations, and read the Cursor status (which builds are installed, gateway values, last request seen).",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/native-integrations"},
			{method: "PUT", path: "/api/native-integrations/claude"},
			{method: "PUT", path: "/api/native-integrations/claude-desktop"},
			{method: "PUT", path: "/api/native-integrations/codex"},
			{method: "PUT", path: "/api/native-integrations/grok"},
			{method: "GET", path: "/api/native-integrations/cursor"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the client rows or toggle result as JSON."},
		},
		mutates: true,
		json:    "payload",
		details: []string{"The list renders per-client state, installed, and desired columns; a blocked disable is named rather than left silent.", "Each client has its own route because a toggle rewrites that client's own config file."},
	},
	{
		command: []string{"agent", "request-user-input"},
		summary: "Show or set whether default mode may ask the operator a question mid-task.",
		routes: []capabilityRoute{
			{method: "GET", path: "/api/codex-auth/features/default-mode-request-user-input"},
			{method: "PUT", path: "/api/codex-auth/features/default-mode-request-user-input"},
		},
		flags: []capabilityFlag{
			{name: "--json", value: "boolean", summary: "Emit the feature state as JSON."},
		},
		mutates: true,
		json:    "payload",
		details: []string{"A bare invocation reads and never writes."},
	},
}

// headCapabilitiesTable mirrors HEAD_CAPABILITIES in src/cli/capabilities.ts.
var headCapabilitiesTable = []headCapability{
	{invocations: []string{"--version", "-v", "version"}, summary: "Print the CLI version and exit.", bannerLine: "ocx --version | -v          Print version"},
	{invocations: []string{"help", "--help", "-h"}, summary: "Print the command list, or one command's usage with `ocx help <command>`.", bannerLine: "ocx help [command]          Show help for a command"},
}
