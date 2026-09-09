package ocxcli

// Golden tests for claude agent-def injection (roster + rendered .md bytes).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func claudeGoldenFiles(t *testing.T, scenario map[string]json.RawMessage) ([][]string, []string) {
	t.Helper()
	var result struct {
		Roster []struct {
			File          string   `json:"file"`
			Name          string   `json:"name"`
			Model         string   `json:"model"`
			Effort        string   `json:"effort,omitempty"`
			BlockedSkills []string `json:"blockedSkills"`
		} `json:"roster"`
		Files [][]string `json:"files"`
	}
	if err := json.Unmarshal(scenario["result"], &result); err != nil {
		t.Fatalf("golden agents result: %v", err)
	}
	roster := []string{}
	for _, row := range result.Roster {
		roster = append(roster, row.File)
	}
	return result.Files, roster
}

func TestClaudeAgentDefsGolden(t *testing.T) {
	scenarios := claudeGoldenScenarios(t)
	for _, tc := range []struct {
		name          string
		subagentModels []string
		claudeCode    *claudeCodeView
		settingsModel string
	}{
		{name: "agent-defs", subagentModels: []string{"gpt-5.5", "gpt-5.2", "claude-opus-4-8"}, settingsModel: "gpt-5.2"},
		{name: "agent-defs-effort", subagentModels: []string{"gpt-5.6-terra"},
			claudeCode: &claudeCodeView{SubagentEffort: "high", Model: "gpt-5.6-sol"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			scenario := scenarios[tc.name]
			wantFiles, _ := claudeGoldenFiles(t, scenario)

			dir := t.TempDir()
			configDir := filepath.Join(dir, ".claude")
			if tc.settingsModel != "" {
				if err := os.MkdirAll(configDir, 0o755); err != nil {
					t.Fatalf("mkdir: %v", err)
				}
				settings := `{"model":"` + tc.settingsModel + `"}`
				if err := os.WriteFile(filepath.Join(configDir, "settings.json"), []byte(settings), 0o644); err != nil {
					t.Fatalf("settings: %v", err)
				}
			}
			defs := claudeBuildAgentDefs(tc.claudeCode, tc.subagentModels, map[string]int64{}, configDir)
			written, err := claudeSyncAgentDefs(defs, configDir)
			if err != nil {
				t.Fatalf("sync: %v", err)
			}
			names := append([]string{}, written...)
			sort.Strings(names)
			if len(names) != len(wantFiles) {
				t.Fatalf("file count: got %d want %d (%v vs %v)", len(names), len(wantFiles), names, wantFiles)
			}
			for i := range wantFiles {
				if wantFiles[i][0] != names[i] {
					t.Errorf("file[%d] name: got %q want %q", i, names[i], wantFiles[i][0])
				}
				got, err := os.ReadFile(filepath.Join(configDir, "agents", names[i]))
				if err != nil {
					t.Fatalf("read %s: %v", names[i], err)
				}
				if string(got) != wantFiles[i][1] {
					t.Errorf("%s rendered bytes differ:\n--- got ---\n%s\n--- want ---\n%s", names[i], got, wantFiles[i][1])
				}
			}
		})
	}
}
