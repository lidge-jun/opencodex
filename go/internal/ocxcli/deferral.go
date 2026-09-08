package ocxcli

// deferral.go is the issue-#55 ledger for the TypeScript delegation seam: every
// command surface that still routes through DelegateToTypeScript during the
// incremental takeover (ADR-0008) is registered here with the reason no Go
// oracle exists yet and the ticket that will lift it. deferral_test.go enforces
// the bijection with the Commands table and OwnershipFor, so the seam cannot
// grow by accident and a registration cannot survive its own flip.
//
// WholeCommand entries name top-level commands whose Commands owner is
// TypeScriptOwned. SubcommandSeam entries name TypeScript-owned verbs inside
// Go-owned families; a seam with an empty Verbs list covers every
// TypeScript-owned verb of a map-driven family (models, lab), and a seam with
// explicit Verbs covers exactly those argv prefixes.

// DeferralKind distinguishes a whole TypeScript-owned top-level command from a
// delegated subcommand surface inside a Go-owned family.
type DeferralKind int

const (
	// WholeCommand is a top-level command that still delegates in full.
	WholeCommand DeferralKind = iota
	// SubcommandSeam is a TypeScript-owned verb (or verb set) of a family whose
	// bare surface and other verbs are Go-native.
	SubcommandSeam
)

// TSDeferral records one delegated surface.
type TSDeferral struct {
	Kind   DeferralKind
	Name   string   // top-level command name (WholeCommand), or family name (SubcommandSeam)
	Verbs  []string // SubcommandSeam only: delegated verbs; empty = the family's runtime map
	Reason string   // why no byte-diff oracle exists for this surface
	Track  string   // ticket / boundary record that will lift the deferral
}

// Surfaces returns the argv prefixes this deferral registers. Verbs may carry
// a colon-separated sub-path for two-level surfaces (observe logs
// rebuild-index is written "logs:rebuild-index").
func (d TSDeferral) Surfaces() [][]string {
	if d.Kind == WholeCommand {
		return [][]string{{d.Name}}
	}
	if len(d.Verbs) == 0 {
		// Map-driven family: covered through the runtime map by the test; the
		// OwnershipFor spot-check uses the family's bare surface which is Go.
		return nil
	}
	out := make([][]string, 0, len(d.Verbs))
	for _, verb := range d.Verbs {
		argv := []string{d.Name}
		argv = append(argv, splitVerbPath(verb)...)
		out = append(out, argv)
	}
	return out
}

// splitVerbPath expands a colon-separated verb path ("logs:rebuild-index") into
// its argv segments.
func splitVerbPath(verb string) []string {
	if verb == "" {
		return []string{verb}
	}
	var parts []string
	start := 0
	for i := 0; i < len(verb); i++ {
		if verb[i] == ':' {
			parts = append(parts, verb[start:i])
			start = i + 1
		}
	}
	return append(parts, verb[start:])
}

// deferredSurfaces is the complete ledger. Keep it sorted by Name within each
// Kind; a new TS-owned surface must enter here with its reason before it can
// legitimately delegate.
var deferredSurfaces = []TSDeferral{
	// --- WholeCommand: top-level commands that still delegate in full ---
	{
		Kind: WholeCommand, Name: "account",
		Reason: "Family is TypeScript-owned per subcommand: the API-routing, pool, and " +
			"OAuth device-flow verbs are Go-native; add-key/import (stdin) and main (native " +
			"CODEX_HOME staging) stay TS until each surface carries its own oracle.",
		Track: "waxiangzi/opencodex#51",
	},
	{
		Kind: WholeCommand, Name: "claude",
		Reason: "Launcher whose env is assembled by whole auth/credential subsystems " +
			"(subscription vs proxy-auth mode, launcher-context provenance, gateway-cache, " +
			"agents-inject); an approximate env assembly would silently break real " +
			"subscription auth, so a parity harness for the auth/env surface is required first.",
		Track: "waxiangzi/opencodex#56",
	},
	{
		Kind: WholeCommand, Name: "connect",
		Reason: "Non-status verbs run the hub machine-API + config-injection transaction, " +
			"which needs its own oracle; the local client-state `status` read is Go-native.",
		Track: "no ticket: needs a hub machine-API oracle",
	},
	{
		Kind: WholeCommand, Name: "login",
		Reason: "Interactive browser/TTY OAuth device flow; no headless byte-diff oracle " +
			"without a live upstream OAuth round-trip.",
		Track: "no ticket: needs an interactive-flow oracle",
	},
	{
		Kind: WholeCommand, Name: "opencode",
		Reason: "Launcher that merges V1/V2 runtime provider blocks into a project JSONC " +
			"config with a live model catalog; a byte-faithful port needs those subsystems " +
			"plus a live-server oracle.",
		Track: "waxiangzi/opencodex#56",
	},
	{
		Kind: WholeCommand, Name: "recover-history",
		Reason: "Runs the async history job and live-proxy/model sync — open sets whose " +
			"bytes are non-deterministic, so no byte-parity oracle exists.",
		Track: "devlog/_plan/260908_go_flip_restore_uninstall_boundary/010_boundary_record.md",
	},
	{
		Kind: WholeCommand, Name: "restore",
		Reason: "Runs the Codex write coordinator; output bytes are non-deterministic " +
			"(integrations/*.json at/txId), so no byte-parity oracle exists.",
		Track: "devlog/_plan/260908_go_flip_restore_uninstall_boundary/010_boundary_record.md",
	},
	{
		Kind: WholeCommand, Name: "service",
		Reason: "Bare `ocx service` normalizes to install (a real OS registration) and the " +
			"other verbs mutate the OS service manager; only the `status` read is Go-native.",
		Track: "no ticket: platform-bound (needs an OS service-manager oracle)",
	},
	{
		Kind: WholeCommand, Name: "setup",
		Reason: "Interactive setup flow with no headless byte-diff oracle.",
		Track:  "no ticket: needs an interactive-flow oracle",
	},
	{
		Kind: WholeCommand, Name: "tray",
		Reason: "Windows-only registry/PowerShell verbs; no Linux platform oracle can " +
			"exercise them.",
		Track: "no ticket: Windows-only surface",
	},
	{
		Kind: WholeCommand, Name: "uninstall",
		Reason: "Removes platform service managers and runs live-proxy/model sync — open, " +
			"non-deterministic mutation surface with no byte-parity oracle.",
		Track: "devlog/_plan/260908_go_flip_restore_uninstall_boundary/010_boundary_record.md",
	},
	{
		Kind: WholeCommand, Name: "update",
		Reason: "Network release fetch + in-place self-replace; no hermetic byte-diff " +
			"oracle can drive it.",
		Track: "waxiangzi/opencodex#56",
	},
	{
		Kind: WholeCommand, Name: "v2",
		Reason: "Reads AND writes the upstream Codex config.toml (feature toggles, threads, " +
			"subagent instructions) and resyncs the catalog through the live proxy; a flip " +
			"needs a byte-exact TOML reader/writer plus a catalog oracle.",
		Track: "waxiangzi/opencodex#56",
	},

	// --- SubcommandSeam: TypeScript-owned verbs inside Go-owned families ---
	{
		Kind: SubcommandSeam, Name: "account",
		Verbs: []string{"add-key", "import", "main"},
		Reason: "Non-runtime account verbs (stdin key import, native CODEX_HOME staging) " +
			"stay TS until each carries its own oracle.",
		Track: "waxiangzi/opencodex#51",
	},
	{
		Kind: SubcommandSeam, Name: "codex-shim",
		Verbs: []string{"install", "uninstall", "remove"},
		Reason: "Mutation verbs replace launch wrappers and run rollback transactions with " +
			"no safe oracle on any platform yet; the bare surface and `status` read are native.",
		Track: "no ticket: needs a launch-wrapper oracle",
	},
	{
		Kind: SubcommandSeam, Name: "config",
		Verbs: nil,
		Reason: "Unknown config verbs mirror the TS CliUsageError byte-for-byte through the " +
			"owner; the read/write verbs in configRuntimeSubcommands are all Go-native.",
		Track: "no ticket: needs a config usage-error oracle",
	},
	{
		Kind: SubcommandSeam, Name: "connect",
		Verbs: []string{"connect", "rotate", "revoke"},
		Reason: "Hub machine-API + config-injection verbs need their own oracle; `status` " +
			"and the family surface are Go-native.",
		Track: "no ticket: needs a hub machine-API oracle",
	},
	{
		Kind: SubcommandSeam, Name: "lab",
		Verbs: nil,
		Reason: "Operator/read verbs (public evidence crypto, automation scheduler, manual " +
			"runs, deeper projection queries) keep the TS owner through labRuntimeSubcommands; " +
			"`status` and the family surface are Go-native.",
		Track: "no ticket: map-driven (each verb needs its own parity oracle)",
	},
	{
		Kind: SubcommandSeam, Name: "logs",
		Verbs: []string{"rebuild-index", "index-status"},
		Reason: "Index maintenance operates the request-history Bun:sqlite directly with no " +
			"management-API surface.",
		Track: "no ticket: needs a request-history index oracle",
	},
	{
		Kind: SubcommandSeam, Name: "models",
		Verbs: nil,
		Reason: "Runtime verbs (live/edit/enable/disable/provider/selected/preset/…) keep " +
			"the TS owner through modelRuntimeSubcommands; the configured-models read is native.",
		Track: "no ticket: map-driven (each verb needs its own parity oracle)",
	},
	{
		Kind: SubcommandSeam, Name: "observe",
		Verbs: []string{"logs:rebuild-index", "logs:index-status"},
		Reason: "Request-history indexer actions read/write the Bun:sqlite index with no " +
			"management route; the rest of the observe family dispatches natively.",
		Track: "no ticket: needs a request-history index oracle",
	},
	{
		Kind: SubcommandSeam, Name: "service",
		Verbs: nil,
		Reason: "Bare `ocx service` and every verb except `status` mutate the OS service " +
			"manager and keep the TS owner.",
		Track: "no ticket: platform-bound (needs an OS service-manager oracle)",
	},
	{
		Kind: SubcommandSeam, Name: "storage",
		Verbs: []string{"codex-logs"},
		Reason: "`storage codex-logs` is observe storage codex-logs spelled through the " +
			"storage command and stays with the observe owner until the observe slice flips it.",
		Track: "no ticket: follows the observe storage slice",
	},
	{
		Kind: SubcommandSeam, Name: "system",
		Verbs: []string{"codex-cli-update"},
		Reason: "Read-only local Codex install inspection outside the management plane (no " +
			"proxy, no API), unlike every other system verb.",
		Track: "no ticket: needs a local Codex-install inspection oracle",
	},
}
