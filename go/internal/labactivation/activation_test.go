package labactivation

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/routing/compatibility"
)

func writeConfig(t *testing.T, dir, content string) *config.Config {
	t.Helper()
	if content == "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		return &config.Config{Raw: map[string]any{}}
	}
	path := filepath.Join(dir, "config.json")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadFromDir(dir)
	if err != nil {
		t.Fatalf("fixture config did not load: %v", err)
	}
	return cfg
}

func writeLabAutomation(t *testing.T, dir, file, content string) {
	t.Helper()
	labDir := filepath.Join(dir, "lab")
	if err := os.MkdirAll(labDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(labDir, file), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestProfilesRequireActivation(t *testing.T) {
	if ProfilesRequireActivation(nil) {
		t.Fatal("absent routingProfiles must not require activation")
	}
	if ProfilesRequireActivation(map[string]any{}) {
		t.Fatal("empty routingProfiles must not require activation")
	}
	if !ProfilesRequireActivation(map[string]any{"demo": map[string]any{"candidates": []any{}}}) {
		t.Fatal("non-empty routingProfiles must require activation")
	}
	if ProfilesRequireActivation([]any{}) {
		t.Fatal("an array routingProfiles must not count (zod rejects it as invalid config)")
	}
}

func TestAutomationEnabledOnDisk(t *testing.T) {

	t.Run("no files means not enabled", func(t *testing.T) {
		if AutomationEnabledOnDisk(t.TempDir()) {
			t.Fatal("empty config dir must not enable automation")
		}
	})

	t.Run("legacy policy file enables", func(t *testing.T) {
		sub := t.TempDir()
		writeLabAutomation(t, sub, automationPolicyFile, `{"enabled": true}`)
		if !AutomationEnabledOnDisk(sub) {
			t.Fatal("legacy automation-policy.json with enabled true must enable automation")
		}
	})

	t.Run("legacy policy disabled stays off", func(t *testing.T) {
		sub := t.TempDir()
		writeLabAutomation(t, sub, automationPolicyFile, `{"enabled": false}`)
		if AutomationEnabledOnDisk(sub) {
			t.Fatal("legacy policy with enabled false must not enable automation")
		}
	})

	t.Run("combined file is the authority", func(t *testing.T) {
		sub := t.TempDir()
		writeLabAutomation(t, sub, automationConfigFile, `{"policy": {"enabled": true}}`)
		writeLabAutomation(t, sub, automationPolicyFile, `{"enabled": false}`)
		if !AutomationEnabledOnDisk(sub) {
			t.Fatal("combined automation-config.json must win over the legacy file")
		}
	})

	t.Run("combined enabled false decides even when legacy says true", func(t *testing.T) {
		sub := t.TempDir()
		writeLabAutomation(t, sub, automationConfigFile, `{"policy": {"enabled": false}}`)
		writeLabAutomation(t, sub, automationPolicyFile, `{"enabled": true}`)
		if AutomationEnabledOnDisk(sub) {
			t.Fatal("combined enabled false must decide (the current dashboard can turn automation off)")
		}
	})

	t.Run("malformed files mean not enabled", func(t *testing.T) {
		sub := t.TempDir()
		writeLabAutomation(t, sub, automationConfigFile, `{not json`)
		writeLabAutomation(t, sub, automationPolicyFile, `{"enabled": "yes"}`)
		if AutomationEnabledOnDisk(sub) {
			t.Fatal("malformed or wrong-typed automation files must not enable automation")
		}
	})

	t.Run("combined without a policy object falls back to legacy", func(t *testing.T) {
		sub := t.TempDir()
		writeLabAutomation(t, sub, automationConfigFile, `{"scheduler": {}}`)
		writeLabAutomation(t, sub, automationPolicyFile, `{"enabled": true}`)
		if !AutomationEnabledOnDisk(sub) {
			t.Fatal("combined file without a policy object must fall back to the legacy file")
		}
	})
}

func TestRequired(t *testing.T) {
	dir := t.TempDir()
	if Required(writeConfig(t, dir, `{}`), dir) {
		t.Fatal("empty config must not require Lab activation")
	}

	profilesDir := t.TempDir()
	profilesJSON := `{"routingProfiles": {"demo": {"candidates": [{"provider": "openai", "model": "gpt-5.5"}]}}}`
	writeConfig(t, profilesDir, profilesJSON)
	if !Required(writeConfig(t, profilesDir, profilesJSON), profilesDir) {
		t.Fatal("a routing profile must require Lab activation")
	}
	if cfg, err := config.LoadFromDir(profilesDir); err != nil || !Required(cfg, profilesDir) {
		t.Fatal("parsed config with routingProfiles must require Lab activation")
	}

	autoDir := t.TempDir()
	writeLabAutomation(t, autoDir, automationConfigFile, `{"policy": {"enabled": true}}`)
	if !Required(writeConfig(t, autoDir, `{}`), autoDir) {
		t.Fatal("automation enabled on disk must require Lab activation")
	}

	// A profile plus automation off still requires activation via the profile.
	bothDir := t.TempDir()
	writeConfig(t, bothDir, profilesJSON)
	writeLabAutomation(t, bothDir, automationConfigFile, `{"policy": {"enabled": false}}`)
	if cfg, err := config.LoadFromDir(bothDir); err != nil || !Required(cfg, bothDir) {
		t.Fatal("a routing profile must require activation even with automation off")
	}
}

func TestActivateRegistersOnlyWhenRequired(t *testing.T) {
	slot := compatibility.NewSlot()
	provider := func(options compatibility.EvidenceOptions) compatibility.CandidateEvidence {
		return compatibility.CandidateEvidence{}
	}

	dir := t.TempDir()
	writeConfig(t, dir, `{}`)
	if activated := Activate(slot, writeConfig(t, dir, `{}`), dir, provider); activated {
		t.Fatal("empty install must not activate")
	}
	if resolved := slot.Resolve(); resolved != nil {
		t.Fatal("a non-required install must register nothing (slot stays nil)")
	}

	profilesDir := t.TempDir()
	writeConfig(t, profilesDir, `{"routingProfiles": {"demo": {"candidates": [{"provider": "openai", "model": "gpt-5.5"}]}}}`)
	cfg, err := config.LoadFromDir(profilesDir)
	if err != nil {
		t.Fatal(err)
	}
	if !Activate(slot, cfg, profilesDir, provider) {
		t.Fatal("a required install must activate")
	}
	if resolved := slot.Resolve(); resolved == nil {
		t.Fatal("activation must register the provider into the core slot")
	}

	// The detach returned by Set only removes its own registration.
	replacement := func(options compatibility.EvidenceOptions) compatibility.CandidateEvidence {
		return nil
	}
	detach := slot.Set(replacement)
	slot.Set(provider)
	detach()
	if resolved := slot.Resolve(); resolved == nil || funcPointer(resolved) != funcPointer(provider) {
		t.Fatal("a stale detach must not remove a newer registration")
	}
	slot.Reset()
	if slot.Resolve() != nil {
		t.Fatal("reset must clear the slot")
	}
}

// funcPointer is the identity proxy for comparing function values (Go funcs
// are only comparable to nil).
func funcPointer(fn compatibility.EvidenceProvider) uintptr {
	return reflect.ValueOf(fn).Pointer()
}
