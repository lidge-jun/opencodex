package ocxcli

// `ocx connect status [--json]` — native render of the local client-connection
// state (port of src/cli/connect.ts handleConnectCommand status branch + the
// connect.ts status collector). connect/rotate/revoke stay TypeScript-owned.

import (
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

type connectionStatus struct {
	state             clientConnectionState
	catalog           string
	token             string
	rotation          string
	catalogAgeSeconds *int64
}

// collectConnectionStatus mirrors collectClientConnectionStatus in
// src/cli/connect.ts. The catalog age is inherently wall-clock relative; the
// parity oracle normalises the volatile digits.
func collectConnectionStatus(now time.Time, dir string) connectionStatus {
	state := readClientConnectionState()
	tokenState := readServiceAPITokenState(dir)
	rotation, _ := inspectRotationGate(state, dir)
	status := connectionStatus{state: state, rotation: rotation}
	if state.kind == connectionConnected {
		value := state.value
		if value.CatalogSyncedAt != nil {
			age := int64(0)
			if syncedAt, parseErr := time.Parse(time.RFC3339Nano, *value.CatalogSyncedAt); parseErr == nil {
				age = (now.UnixMilli() - syncedAt.UnixMilli()) / 1000
				if age < 0 {
					age = 0
				}
			}
			status.catalogAgeSeconds = &age
		}
		if tokenState.kind == "absent" {
			status.token = "missing"
		} else if tokenState.kind == "unsafe" {
			status.token = "unsafe"
		} else if tokenState.fingerprint == value.TokenFingerprint {
			status.token = "owned"
		} else {
			status.token = "changed"
		}
	} else {
		if tokenState.kind == "absent" {
			status.token = "missing"
		} else if tokenState.kind == "unsafe" {
			status.token = "unsafe"
		} else {
			status.token = "changed"
		}
	}
	status.catalog = catalogStatus()
	return status
}

func statusLines(status connectionStatus) []string {
	if status.state.kind != connectionConnected {
		line := "Connection: " + string(status.state.kind)
		if status.state.reason != "" {
			line += " (" + status.state.reason + ")"
		}
		return []string{line}
	}
	value := status.state.value
	lines := []string{
		"Connection: connected",
		"Hub: " + value.ServerURL,
		fmt.Sprintf("Management: %s (%s)", value.ManagementURL, value.ManagementTransport),
		fmt.Sprintf("Protocol: %d", value.ProtocolVersion),
		"API key id: " + value.APIKeyID,
		"Clients: " + joinClientNames(value.SelectedClients),
		"Token file: " + status.token,
		"Key rotation: " + status.rotation,
	}
	catalogLine := "Catalog: " + status.catalog
	if status.catalogAgeSeconds != nil {
		catalogLine += fmt.Sprintf(" (%ds old)", *status.catalogAgeSeconds)
	}
	return append(lines, catalogLine)
}

func joinClientNames(clients []string) string {
	if len(clients) == 0 {
		return ""
	}
	out := ""
	for i, client := range clients {
		if i > 0 {
			out += ", "
		}
		out += client
	}
	return out
}

// connectionStatusJSON mirrors the status JSON document in TypeScript key
// order (JSON.stringify(value, null, 2)).
type connectionStatusJSON struct {
	State               string   `json:"state"`
	Reason              *string  `json:"reason,omitempty"`
	ServerURL           *string  `json:"serverUrl,omitempty"`
	ManagementURL       *string  `json:"managementUrl,omitempty"`
	ManagementTransport *string  `json:"managementTransport,omitempty"`
	ProtocolVersion     *int     `json:"protocolVersion,omitempty"`
	APIKeyID            *string  `json:"apiKeyId,omitempty"`
	SelectedClients     []string `json:"selectedClients,omitempty"`
	ConnectedAt         *string  `json:"connectedAt,omitempty"`
	CatalogSyncedAt     *string  `json:"catalogSyncedAt,omitempty"`
	CatalogAgeSeconds   *int64   `json:"catalogAgeSeconds,omitempty"`
	Catalog             string   `json:"catalog"`
	Token               string   `json:"token"`
	Rotation            string   `json:"rotation"`
}

func buildStatusJSON(status connectionStatus) connectionStatusJSON {
	out := connectionStatusJSON{
		State:    string(status.state.kind),
		Catalog:  status.catalog,
		Token:    status.token,
		Rotation: status.rotation,
	}
	if status.state.kind == connectionInvalid || status.state.kind == connectionMismatched {
		reason := status.state.reason
		out.Reason = &reason
	}
	if status.state.kind != connectionConnected {
		return out
	}
	value := status.state.value
	out.ServerURL = &value.ServerURL
	out.ManagementURL = &value.ManagementURL
	transport := value.ManagementTransport
	out.ManagementTransport = &transport
	protocol := value.ProtocolVersion
	out.ProtocolVersion = &protocol
	out.APIKeyID = &value.APIKeyID
	out.SelectedClients = value.SelectedClients
	connectedAt := value.ConnectedAt
	out.ConnectedAt = &connectedAt
	if value.CatalogSyncedAt != nil {
		syncedAt := *value.CatalogSyncedAt
		out.CatalogSyncedAt = &syncedAt
		if status.catalogAgeSeconds != nil {
			age := *status.catalogAgeSeconds
			out.CatalogAgeSeconds = &age
		}
	}
	return out
}

// jsonIndented writes value like console.log(JSON.stringify(value, null, 2)).
// HTML escaping is disabled because V8's JSON.stringify does not escape
// <, >, &; Go's encoding/json escapes them by default.
func jsonIndented(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

// reportClientUsageError mirrors the runCliAction CliUsageError path: message
// plus an optional usage block on stderr, exit code 2.
func reportClientUsageError(deps Deps, message string, usage string) int {
	fmt.Fprintf(deps.Stderr, "Error: %s\n", message)
	if usage != "" {
		fmt.Fprintln(deps.Stderr, usage)
	}
	return 2
}

func reportClientError(deps Deps, message string) int {
	fmt.Fprintf(deps.Stderr, "Error: %s\n", message)
	return ExitFailure
}

func clientUnexpectedArgs(args []string) string {
	return "Unexpected argument(s): " + joinArgsForMessage(args)
}

func joinArgsForMessage(args []string) string {
	out := ""
	for i, arg := range args {
		if i > 0 {
			out += " "
		}
		out += arg
	}
	return out
}

// takeFlagsOnce consumes the first occurrence of each recognized flag (TS
// takeFlag semantics): a repeated flag is not a silent success, it falls
// through to the leftovers that reportClientUsageError names. Leftover order
// is preserved.
func takeFlagsOnce(args []string, recognized ...string) (taken map[string]bool, leftovers []string) {
	taken = make(map[string]bool)
	for _, arg := range args {
		if !taken[arg] {
			for _, flag := range recognized {
				if arg == flag {
					taken[arg] = true
					goto keep
				}
			}
		}
		leftovers = append(leftovers, arg)
	keep:
	}
	return taken, leftovers
}

// runConnectStatus implements `ocx connect status [--json]`. The family's
// connect/rotate/revoke subcommands stay TypeScript-owned (file header).
func runConnectStatus(args []string, deps Deps) int {
	taken, leftovers := takeFlagsOnce(args, "--json")
	if len(leftovers) != 0 {
		return reportClientUsageError(deps, clientUnexpectedArgs(leftovers), connectUsage)
	}
	jsonOutput := taken["--json"]
	dir, err := config.Dir()
	if err != nil {
		return reportClientError(deps, err.Error())
	}
	status := collectConnectionStatus(time.Now(), dir)
	if jsonOutput {
		if err := jsonIndented(deps.Stdout, buildStatusJSON(status)); err != nil {
			return reportClientError(deps, err.Error())
		}
		return ExitOK
	}
	for _, line := range statusLines(status) {
		fmt.Fprintln(deps.Stdout, line)
	}
	return ExitOK
}
