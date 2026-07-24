package codex

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

const journalFilename = "opencodex-journal.json"

type Journal struct {
	Version             int     `json:"version"`
	OriginalConfig      string  `json:"originalConfig"`
	OriginalProfile     *string `json:"originalProfile"`
	InjectedConfigHash  string  `json:"injectedConfigHash,omitempty"`
	InjectedProfileHash *string `json:"injectedProfileHash,omitempty"`
	PID                 int     `json:"pid"`
	Timestamp           string  `json:"timestamp"`
}

type RestoreJournalResult struct {
	ConfigRestored  bool
	ProfileRestored bool
	ConfigChanged   bool
	ProfileChanged  bool
	Complete        bool
}

func JournalPath(codexHome string) string { return filepath.Join(codexHome, journalFilename) }

// WriteJournal snapshots config and profile before injection. Existing valid journals win.
func WriteJournal(codexHome string, pid int) error {
	if _, err := readJournal(codexHome); err == nil {
		return nil
	}
	configPath := filepath.Join(codexHome, "config.toml")
	config, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	var originalProfile *string
	profile, err := os.ReadFile(filepath.Join(codexHome, "opencodex.config.toml"))
	if err == nil {
		encoded := base64.StdEncoding.EncodeToString(profile)
		originalProfile = &encoded
	} else if !os.IsNotExist(err) {
		return err
	}
	journal := Journal{
		Version:         1,
		OriginalConfig:  base64.StdEncoding.EncodeToString(config),
		OriginalProfile: originalProfile,
		PID:             pid,
		Timestamp:       time.Now().UTC().Format(time.RFC3339Nano),
	}
	return writeJournal(codexHome, journal)
}

func MarkJournalInjectedState(codexHome string, config, profile []byte) error {
	journal, err := readJournal(codexHome)
	if err != nil {
		return err
	}
	if journal.InjectedConfigHash != "" {
		return nil
	}
	journal.InjectedConfigHash = contentHash(config)
	profileHash := contentHash(profile)
	journal.InjectedProfileHash = &profileHash
	return writeJournal(codexHome, journal)
}

func RemoveJournal(codexHome string) error {
	err := os.Remove(JournalPath(codexHome))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func RestoreJournal(codexHome string) (RestoreJournalResult, error) {
	journal, err := readJournal(codexHome)
	if err != nil {
		return RestoreJournalResult{}, err
	}
	configPath := filepath.Join(codexHome, "config.toml")
	profilePath := filepath.Join(codexHome, "opencodex.config.toml")
	currentConfig, configErr := os.ReadFile(configPath)
	if configErr != nil && !os.IsNotExist(configErr) {
		return RestoreJournalResult{}, configErr
	}
	currentProfile, profileErr := os.ReadFile(profilePath)
	profileExists := profileErr == nil
	if profileErr != nil && !os.IsNotExist(profileErr) {
		return RestoreJournalResult{}, profileErr
	}
	configUnchanged := journal.InjectedConfigHash == "" || contentHash(currentConfig) == journal.InjectedConfigHash
	profileUnchanged := journal.InjectedProfileHash == nil || contentHash(currentProfile) == *journal.InjectedProfileHash
	result := RestoreJournalResult{ConfigChanged: !configUnchanged, ProfileChanged: !profileUnchanged}
	if configUnchanged {
		original, decodeErr := base64.StdEncoding.DecodeString(journal.OriginalConfig)
		if decodeErr != nil {
			return result, fmt.Errorf("decode journal config: %w", decodeErr)
		}
		if err := atomicWriteFile(configPath, original, 0o600); err != nil {
			return result, err
		}
		result.ConfigRestored = true
	}
	if profileUnchanged {
		if journal.OriginalProfile == nil {
			if profileExists {
				if err := os.Remove(profilePath); err != nil {
					return result, err
				}
			}
		} else {
			original, decodeErr := base64.StdEncoding.DecodeString(*journal.OriginalProfile)
			if decodeErr != nil {
				return result, fmt.Errorf("decode journal profile: %w", decodeErr)
			}
			if err := atomicWriteFile(profilePath, original, 0o600); err != nil {
				return result, err
			}
		}
		result.ProfileRestored = true
	}
	result.Complete = result.ConfigRestored && result.ProfileRestored
	if result.Complete {
		if err := RemoveJournal(codexHome); err != nil {
			return result, err
		}
	}
	return result, nil
}

// ReconcileJournal restores a stale journal only after its owning PID is dead.
func ReconcileJournal(codexHome string, processAlive func(int) bool) (bool, error) {
	journal, err := readJournal(codexHome)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		// A corrupt journal cannot be trusted and must not block future snapshots.
		_ = RemoveJournal(codexHome)
		return false, nil
	}
	if processAlive == nil {
		processAlive = platform.ProcessAlive
	}
	if processAlive(journal.PID) {
		return false, nil
	}
	result, err := RestoreJournal(codexHome)
	return result.ConfigRestored || result.ProfileRestored, err
}

func readJournal(codexHome string) (Journal, error) {
	data, err := os.ReadFile(JournalPath(codexHome))
	if err != nil {
		return Journal{}, err
	}
	var journal Journal
	if err := json.Unmarshal(data, &journal); err != nil {
		return Journal{}, fmt.Errorf("parse Codex journal: %w", err)
	}
	if journal.Version != 1 || journal.PID <= 0 || journal.OriginalConfig == "" {
		return Journal{}, fmt.Errorf("invalid Codex journal")
	}
	return journal, nil
}

func writeJournal(codexHome string, journal Journal) error {
	data, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	return atomicWriteFile(JournalPath(codexHome), data, 0o600)
}

func contentHash(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
