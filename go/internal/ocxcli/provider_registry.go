package ocxcli

import (
	_ "embed"
	"encoding/json"
)

// providerRegistryJSON is generated from src/providers/registry.ts through
// providerConfigSeed. It keeps Go-owned provider add/list behavior on the same
// presets as the TypeScript CLI without duplicating a lossy hand-maintained list.
//
//go:embed provider_registry.json
var providerRegistryJSON []byte

type providerRegistryEntry struct {
	ID       string         `json:"id"`
	Label    string         `json:"label"`
	AuthKind string         `json:"authKind"`
	Seed     map[string]any `json:"seed"`
}

var providerRegistry []providerRegistryEntry
var providerRegistryByID map[string]providerRegistryEntry

func init() {
	if err := json.Unmarshal(providerRegistryJSON, &providerRegistry); err != nil {
		panic("invalid embedded provider registry: " + err.Error())
	}
	providerRegistryByID = make(map[string]providerRegistryEntry, len(providerRegistry))
	for _, entry := range providerRegistry {
		providerRegistryByID[entry.ID] = entry
	}
}
