package ocxcli

// `ocx disconnect` — native teardown of the remote-hub client state (port of
// src/cli/connect.ts handleDisconnectCommand + src/client/connect.ts
// disconnectClient). The transaction mirrors TypeScript step for step so the
// resulting on-disk state (config.json, service-api-token, Codex config.toml,
// journal, catalog) is byte-identical:
//
//  1. refuse unless the persisted client state is connected
//  2. refuse unless the service token file exists and is owned
//  3. unwind Codex routing through the journal when codex is a selected client
//  4. remove the owned token file
//  5. restore the pre-connect catalog unless --keep-catalog
//  6. clear the config.json client/runtimeRole keys (with rebase provenance)
//  7. render the same human or JSON payload the TypeScript CLI prints

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/configschema"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

func writeAtomic(path string, payload []byte) error { return writeStateFileAtomic(path, payload) }

func isConnectedTo(value *clientConnectionValue, client string) bool {
	if value == nil {
		return false
	}
	for _, selected := range value.SelectedClients {
		if selected == client {
			return true
		}
	}
	return false
}

// validLocalCatalog reads the connected catalog and requires it to parse as a
// JSON object (validLocalCatalog in src/client/connect.ts).
func validLocalCatalog(codexHome string) (string, error) {
	raw, err := os.ReadFile(defaultCatalogPath(codexHome))
	if err != nil {
		return "", err
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", errors.New("connected catalog is malformed")
	}
	if parsed == nil {
		return "", errors.New("connected catalog is malformed")
	}
	if _, ok := parsed.(map[string]any); !ok {
		return "", errors.New("connected catalog is malformed")
	}
	return string(raw), nil
}

// restorePriorCatalog mirrors restorePriorCatalog in src/client/connect.ts:
// removed | restored | absent | changed.
func restorePriorCatalog(value *clientConnectionValue, codexHome string) string {
	path := defaultCatalogPath(codexHome)
	if _, err := os.Stat(path); err != nil {
		return "absent"
	}
	body, err := validLocalCatalog(codexHome)
	if err != nil {
		return "changed"
	}
	if value.CatalogFingerprint == nil || sha256Base64URL(body) != *value.CatalogFingerprint {
		return "changed"
	}
	if value.PriorCatalog != nil && *value.PriorCatalog != "" {
		decoded, decodeErr := base64.StdEncoding.DecodeString(*value.PriorCatalog)
		if decodeErr != nil || writeAtomic(path, decoded) != nil {
			return "changed"
		}
		return "restored"
	}
	// priorCatalog "" or absent: the connection found no pre-connect catalog, so
	// removal is the restoration (TypeScript wraps the whole transaction in a
	// catch that maps every failure — including a raced unlink — to changed).
	if err := os.Remove(path); err != nil {
		return "changed"
	}
	return "removed"
}

// clearClientConnection clears the client + runtimeRole top-level keys through
// the config mutation coordinator, writing the schema-normalised document with
// the configRebaseProvenance record TypeScript persists on top-level deletion.
// The outcome mirrors TypeScript's clearClientConnection: committed | absent |
// conflict, where conflict means the persisted client block no longer matches
// the apiKeyId the transaction started from.
func clearClientConnection(configPath string, expectedAPIKeyID string) (string, error) {
	drop := func(raw []byte) (string, []byte, bool, error) {
		parsed, err := jsonwire.Parse(raw)
		if err != nil {
			return "", nil, false, err
		}
		role := parsed.Find("runtimeRole")
		clientBlock := parsed.Find("client")
		if clientBlock == nil && (role == nil || role.String() != "client") {
			return "absent", nil, false, nil
		}
		clientKey := ""
		if clientBlock != nil {
			clientKey = clientBlock.Find("apiKeyId").String()
		}
		if clientBlock == nil || role == nil || role.String() != "client" || clientKey != expectedAPIKeyID {
			return "conflict", nil, false, nil
		}
		parsed.Delete("client")
		parsed.Delete("runtimeRole")
		provenance := jsonwire.ObjectValue()
		provenance.Set("version", jsonwire.NumberFrom(1))
		deleted := jsonwire.EmptyArray()
		deleted.AppendArray(jsonwire.StringValue("client"))
		deleted.AppendArray(jsonwire.StringValue("runtimeRole"))
		provenance.Set("deletedTopLevelKeys", deleted)
		parsed.Set("configRebaseProvenance", provenance)
		edited, err := parsed.Encode()
		if err != nil {
			return "", nil, false, err
		}
		normalized, err := configschema.ValidateCandidateJSON(edited)
		if err != nil {
			return "", nil, false, err
		}
		normalizedBytes, err := normalized.IndentedJSON()
		if err != nil {
			return "", nil, false, err
		}
		return "", normalizedBytes, true, nil
	}
	outcome := ""
	_, err := configschema.WithRevalidatedConfigMutation(context.Background(), configPath, nil, func(raw []byte, _ int64) ([]byte, bool, error) {
		value, replacement, changed, err := drop(raw)
		if err != nil {
			return nil, false, err
		}
		outcome = value
		if !changed {
			return nil, false, nil
		}
		return append(replacement, '\n'), true, nil
	})
	if err != nil {
		return "", err
	}
	if outcome != "" {
		return outcome, nil
	}
	return "committed", nil
}

// disconnectResult mirrors the disconnectClient return shape.
type disconnectResult struct {
	restored        bool
	tokenRemoved    bool
	catalogRemoved  bool
	catalogRestored bool
	apiKeyID        string
}

func runClientDisconnect(args []string, deps Deps) int {
	taken, leftovers := takeFlagsOnce(args, "--keep-catalog", "--json")
	if len(leftovers) != 0 {
		return reportClientUsageError(deps, clientUnexpectedArgs(leftovers), disconnectUsage)
	}
	keepCatalog := taken["--keep-catalog"]
	jsonOutput := taken["--json"]
	dir, err := config.Dir()
	if err != nil {
		return reportClientError(deps, err.Error())
	}
	configPath, err := config.Path()
	if err != nil {
		return reportClientError(deps, err.Error())
	}
	codexHome, err := codexHomeFromEnv()
	if err != nil {
		return reportClientError(deps, err.Error())
	}

	state := readClientConnectionState()
	if state.kind != connectionConnected {
		return reportClientError(deps, "disconnect refused: client state is "+string(state.kind))
	}
	value := state.value
	token := readServiceAPITokenState(dir)
	if token.kind != "present" || token.fingerprint != value.TokenFingerprint {
		if token.kind == "absent" {
			return reportClientError(deps, "disconnect refused: service token is missing")
		}
		return reportClientError(deps, "disconnect refused: service token ownership changed")
	}

	restored := true
	if isConnectedTo(value, "codex") {
		journal, readErr := readJournal(codexHome)
		if readErr != nil {
			return reportClientError(deps, readErr.Error())
		}
		kind, apiKeyID, _ := journal.owner()
		switch kind {
		case journalOwnerClient:
			if apiKeyID != value.APIKeyID {
				return reportClientError(deps, "disconnect refused: Codex journal ownership conflicts with the connected key")
			}
			restored = restoreJournalState(codexHome).complete
		case journalOwnerProcess:
			restored = restoreJournalState(codexHome).complete
		default:
			if isCodexRoutingInjected(codexHome) {
				return reportClientError(deps, "disconnect refused: Codex routing is injected but no journal records the original state")
			}
		}
		if !restored {
			return reportClientError(deps, "disconnect refused: Codex journal restore was partial")
		}
	}

	tokenRemoval, removalErr := removeServiceAPITokenFileIfOwned(dir, value.TokenFingerprint)
	if removalErr != nil {
		return reportClientError(deps, removalErr.Error())
	}
	if tokenRemoval == "changed" {
		return reportClientError(deps, "disconnect refused: service token changed before removal")
	}
	catalogRemoval := "absent"
	if !keepCatalog {
		catalogRemoval = restorePriorCatalog(value, codexHome)
		if catalogRemoval == "changed" {
			return reportClientError(deps, "disconnect refused: catalog ownership changed")
		}
	}
	if outcome, clearErr := clearClientConnection(configPath, value.APIKeyID); clearErr != nil {
		return reportClientError(deps, clearErr.Error())
	} else if outcome != "committed" {
		return reportClientError(deps, "disconnect refused: client state changed before final commit")
	}

	result := disconnectResult{
		restored:        restored,
		tokenRemoved:    tokenRemoval == "removed",
		catalogRemoved:  catalogRemoval == "removed" || catalogRemoval == "restored",
		catalogRestored: catalogRemoval == "restored",
		apiKeyID:        value.APIKeyID,
	}
	if jsonOutput {
		if err := jsonIndented(deps.Stdout, disconnectPayloadJSON(result)); err != nil {
			return reportClientError(deps, err.Error())
		}
		return ExitOK
	}
	fmt.Fprintln(deps.Stdout, "Disconnected locally; native Codex state was restored.")
	fmt.Fprintf(deps.Stdout, "The hub key %s is still valid. Revoke it from Integrations → API Keys.\n", result.apiKeyID)
	return ExitOK
}

type disconnectRevokePayload struct {
	APIKeyID string `json:"apiKeyId"`
	Location string `json:"location"`
}

type disconnectPayload struct {
	Restored        bool                    `json:"restored"`
	TokenRemoved    bool                    `json:"tokenRemoved"`
	CatalogRemoved  bool                    `json:"catalogRemoved"`
	CatalogRestored bool                    `json:"catalogRestored"`
	APIKeyID        string                  `json:"apiKeyId"`
	Revoke          disconnectRevokePayload `json:"revoke"`
}

func disconnectPayloadJSON(result disconnectResult) disconnectPayload {
	return disconnectPayload{
		Restored:        result.restored,
		TokenRemoved:    result.tokenRemoved,
		CatalogRemoved:  result.catalogRemoved,
		CatalogRestored: result.catalogRestored,
		APIKeyID:        result.apiKeyID,
		Revoke: disconnectRevokePayload{
			APIKeyID: result.apiKeyID,
			Location: "Integrations → API Keys",
		},
	}
}
