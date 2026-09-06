// Package labactivation reproduces the Compatibility Lab opt-in activation
// gate (ADR-0008, ticket #19). It mirrors src/lib/lab-activation.ts: an
// install "uses" the Lab when any routing profile exists in config.json OR Lab
// automation is enabled on disk under <configDir>/lab/automation-config.json
// (with automation-policy.json as the legacy fallback). The TypeScript
// composition root calls labActivationRequired before it activates Lab; the
// equivalent Go decision must answer identically from the same on-disk state,
// which is what the differential oracle (tests/go-lab-gate-parity.test.ts)
// proves against fixture directories.
//
// This package is the seam, not the Lab: it imports no Lab content. The
// provider-slot seam lives in go/internal/routing/compatibility, and nothing
// in the module tree except a future composition root (the flip, ticket #41)
// or a test registers an evidence provider through it. Until the Lab batch
// (ticket #33) lands real Go Lab content, "a no-Lab user executes no Lab code
// in Go" holds because no Go package imports Lab content at all, and it stays
// machine-checkable by the absence of any importer of this package outside
// tests (go list -deps ./... shows only the sidecar's own read-route core,
// which imports neither this package nor the slot).
package labactivation

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/routing/compatibility"
)

// AutomationConfigFile is the current automation authority, sibling of the
// legacy policy file under <configDir>/lab/. Mirrors the combined path the TS
// side reads first (dirname of the legacy path joined with
// "automation-config.json").
const (
	automationConfigFile = "automation-config.json"
	automationPolicyFile = "automation-policy.json"
)

// readJSONObject returns the decoded top-level JSON value of path, or nil when
// the file is absent or not a single valid JSON object. Mirrors
// readJsonIfPresent in src/lib/lab-activation.ts: the detector must never
// throw and must never import Lab persistence to answer the question.
func readJSONValue(path string) (any, bool) {
	file, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}
	return value, true
}

// policyEnabled extracts policy.enabled from a decoded object. Mirrors the TS
// shape navigation: the combined file carries {policy: {enabled}}.
func policyEnabled(value any) (bool, bool) {
	object, ok := value.(map[string]any)
	if !ok {
		return false, false
	}
	policy, ok := object["policy"].(map[string]any)
	if !ok {
		return false, false
	}
	enabled, ok := policy["enabled"].(bool)
	return enabled, ok
}

// legacyEnabled extracts enabled from the legacy automation-policy.json root.
func legacyEnabled(value any) (bool, bool) {
	object, ok := value.(map[string]any)
	if !ok {
		return false, false
	}
	enabled, ok := object["enabled"].(bool)
	return enabled, ok
}

// AutomationEnabledOnDisk mirrors labAutomationEnabledOnDisk. Precedence is
// deliberate: the combined automation-config.json is the current authority
// (with policy.enabled present, even false, it decides); only when the
// combined file is absent or carries no policy object does the legacy
// automation-policy.json answer.
func AutomationEnabledOnDisk(configDir string) bool {
	legacyPath := filepath.Join(configDir, "lab", automationPolicyFile)
	if combined, ok := readJSONValue(filepath.Join(filepath.Dir(legacyPath), automationConfigFile)); ok {
		if enabled, decided := policyEnabled(combined); decided {
			return enabled
		}
	}
	if legacy, ok := readJSONValue(legacyPath); ok {
		if enabled, decided := legacyEnabled(legacy); decided {
			return enabled
		}
	}
	return false
}

// ProfilesRequireActivation mirrors `Object.keys(config.routingProfiles ??
// {}).length > 0`: the raw routingProfiles value from config.json requires
// activation exactly when it is an object with at least one key. Any other
// shape (absent, null, array, empty object) does not.
func ProfilesRequireActivation(routingProfiles any) bool {
	profiles, ok := routingProfiles.(map[string]any)
	return ok && len(profiles) > 0
}

// Required mirrors labActivationRequired: any routing profile, or automation
// enabled on disk. configFile is the parsed config.json (see internal/config);
// configDir is the directory the TS process resolved as its config home.
func Required(cfg *config.Config, configDir string) bool {
	if cfg == nil {
		return AutomationEnabledOnDisk(configDir)
	}
	if ProfilesRequireActivation(cfg.Raw["routingProfiles"]) {
		return true
	}
	return AutomationEnabledOnDisk(configDir)
}

// Activate performs the activation side of the seam: when required, it
// installs the evidence provider into the core slot; when not required it
// performs no registration and the slot stays nil. It reports whether
// activation happened. This mirrors the TypeScript composition root, which
// calls activateLab only when labActivationRequired is true — the synchronous,
// gap-free guarantee the owner decision (devlog 010) requires the Go side to
// reproduce. The real Lab evidence provider arrives with ticket #33; until
// then the caller (a test, or the flip composition root) supplies one, so the
// seam contract is proven without pretending Lab content exists.
func Activate(slot *compatibility.Slot, cfg *config.Config, configDir string, provider compatibility.EvidenceProvider) bool {
	if !Required(cfg, configDir) {
		return false
	}
	slot.Set(provider)
	return true
}
