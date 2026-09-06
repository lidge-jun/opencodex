package sidecar

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// repairGolden is one row of the committed golden file. The expected bytes are
// produced by the REAL TypeScript repair (backfillResponsesFieldsJson, via
// .tmp/gen-repair-goldens.mjs, bun only), so this unit test pins Go's mirror
// against the TypeScript oracle without a live server.
type repairGolden struct {
	Name     string `json:"name"`
	Input    string `json:"input"`
	Expected string `json:"expected"`
	Changed  bool   `json:"changed"`
}

func loadRepairGoldens(t *testing.T) []repairGolden {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "responses-repair-goldens.json"))
	if err != nil {
		t.Fatalf("read goldens: %v", err)
	}
	var goldens []repairGolden
	if err := json.Unmarshal(raw, &goldens); err != nil {
		t.Fatalf("decode goldens: %v", err)
	}
	if len(goldens) == 0 {
		t.Fatal("golden file is empty")
	}
	return goldens
}

// TestRepairResponsesJSONGoldens pins the field-backfill mirror to the
// TypeScript oracle across every documented shape: sparse messages, status
// mapping, id synthesis namespaces, compaction exclusion, key-order and
// number-literal preservation, and raw-bytes identity when nothing changed.
func TestRepairResponsesJSONGoldens(t *testing.T) {
	for _, golden := range loadRepairGoldens(t) {
		golden := golden
		t.Run(golden.Name, func(t *testing.T) {
			out, changed := RepairResponsesJSONBody([]byte(golden.Input))
			if !bytes.Equal(out, []byte(golden.Expected)) {
				t.Fatalf("repair diverged from TS oracle\n got: %s\nwant: %s", out, golden.Expected)
			}
			if changed != golden.Changed {
				t.Fatalf("changed = %v, want %v (raw-bytes identity contract)", changed, golden.Changed)
			}
		})
	}
}

// TestRepairResponsesJSONInvalidBodyIsRawPassthrough: a body that is not a JSON
// object is not the repair's problem — the caller relays the original bytes.
func TestRepairResponsesJSONInvalidBodyIsRawPassthrough(t *testing.T) {
	for _, body := range []string{`[]`, `"text"`, `7`, `{`, `not json`, ``} {
		out, changed := RepairResponsesJSONBody([]byte(body))
		if changed {
			t.Fatalf("body %q reported changed", body)
		}
		if string(out) != body {
			t.Fatalf("body %q was rewritten to %q", body, out)
		}
	}
}

// TestRepairResponsesJSONMutatesDocumentOrder: adding an id next to an existing
// empty-string id must replace in place, exactly like a TS object spread.
func TestRepairResponsesJSONEmptyStringIDReplacesInPlace(t *testing.T) {
	input := `{"id":"r","status":"completed","output":[{"type":"message","id":"","content":[{"type":"output_text","text":"hi"}]}]}`
	out, changed := RepairResponsesJSONBody([]byte(input))
	if !changed {
		t.Fatal("expected a change")
	}
	// The id key keeps its original position (between type and content) and
	// only its value is replaced; no second id is appended.
	want := `{"id":"r","status":"completed","output":[{"type":"message","id":"msg_ocx_0","content":[{"type":"output_text","text":"hi","annotations":[]}],"status":"completed"}]}`
	if string(out) != want {
		t.Fatalf("got  %s\nwant %s", out, want)
	}
}

func TestResponseRepairPipelineRunsOrderedModelAndImageRestoresBeforeBackfill(t *testing.T) {
	input := `{"model":"upstream","output":[{"type":"function_call","name":"image_gen__create","arguments":"{}"},{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`
	p := responseRepairPipeline{modelID: "client-model", imageAliases: map[string]imageAlias{"image_gen__create": {name: "create", namespace: "image_gen"}}}
	out, changed := p.repairJSON([]byte(input))
	if !changed {
		t.Fatal("pipeline reported unchanged")
	}
	want := `{"model":"client-model","output":[{"type":"function_call","name":"create","arguments":"{}","namespace":"image_gen","id":"fc_ocx_0"},{"type":"message","content":[{"type":"output_text","text":"ok","annotations":[]}],"id":"msg_ocx_1","status":"completed"}]}`
	if string(out) != want {
		t.Fatalf("got %s\nwant %s", out, want)
	}
}
