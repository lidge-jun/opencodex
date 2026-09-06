package main

// The labcheck subcommand is the differential-oracle entry point for the Go
// Lab activation gate (ADR-0008, ticket #19): given a config directory, it
// prints the gate's three inputs and decision the way tests/go-lab-gate-
// parity.test.ts compares them against src/lib/lab-activation.ts. Inert on the
// live path, like authcheck.

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/labactivation"
)

type labGateResult struct {
	AutomationEnabled bool `json:"automationEnabled"`
	ProfilesNonEmpty  bool `json:"profilesNonEmpty"`
	Required          bool `json:"required"`
}

func runLabCheck() error {
	if len(os.Args) < 3 {
		return fmt.Errorf("labcheck requires a config directory argument")
	}
	configDir := os.Args[2]
	cfg, err := config.LoadFromDir(configDir)
	if err != nil {
		// The gate must still answer for a config.json the TS side would
		// salvage: report on what the loader could read (an empty document).
		cfg = &config.Config{Raw: map[string]any{}}
	}
	automation := labactivation.AutomationEnabledOnDisk(configDir)
	profiles := labactivation.ProfilesRequireActivation(cfg.Raw["routingProfiles"])
	encoded, err := json.Marshal(labGateResult{
		AutomationEnabled: automation,
		ProfilesNonEmpty:  profiles,
		Required:          automation || profiles,
	})
	if err != nil {
		return fmt.Errorf("labcheck: encode: %w", err)
	}
	fmt.Println(string(encoded))
	return nil
}
