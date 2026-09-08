package ocxcli

import (
	"maps"
	"slices"
	"testing"
)

// deferral_test.go is the hard boundary for the TypeScript delegation seam
// (issue #55): every command surface that still routes through
// DelegateToTypeScript must be registered in deferredSurfaces with a reason,
// and no registered surface may outlive its flip. Together with
// TestOwnershipMapMatchesDispatch (top-level dispatch behavior) this keeps the
// seam explicit: a top-level command cannot become TypeScript-owned by accident,
// a registration cannot silently go stale, and a delegated verb inside a
// Go-owned family must enter the ledger (positively for enumerable seams,
// through the runtime map for models/lab, or as a Fallback seam for families
// whose Go-native surface is a carve-out).

// TestDeferredSurfacesBijectionWithCommands asserts the Commands table and
// the deferral registry agree on the top level: every command whose owner is
// TypeScriptOwned must have a WholeCommand entry, and vice versa. Flipping a
// command to Go-owned without deleting its entry (or adding a TS command
// without registering it) fails here.
func TestDeferredSurfacesBijectionWithCommands(t *testing.T) {
	registered := make(map[string]bool)
	for _, d := range deferredSurfaces {
		if d.Kind == WholeCommand {
			if registered[d.Name] {
				t.Fatalf("duplicate WholeCommand deferral for %q", d.Name)
			}
			registered[d.Name] = true
			if d.Name == "" || d.Reason == "" {
				t.Fatalf("deferral for %q must carry Name and Reason", d.Name)
			}
		}
	}
	for _, command := range Commands {
		isTS := command.Owner == TypeScriptOwned
		if registered[command.Name] && !isTS {
			t.Fatalf(
				"command %q is registered as a WholeCommand deferral but its Commands owner is %q; "+
					"delete the deferral entry (flip is complete) or revert the ownership flip",
				command.Name, command.Owner)
		}
		if isTS && !registered[command.Name] {
			t.Fatalf(
				"command %q is TypeScriptOwned in Commands but has no WholeCommand deferral entry; "+
					"every TS-owned command must be registered with its deferral reason",
				command.Name)
		}
	}
	// Ghost entries (a registration whose command no longer exists in Commands)
	// must fail too: they would otherwise let a deleted command keep a stale
	// ledger row that masks a later accidental re-add.
	for name := range registered {
		if _, ok := commandForName(name); !ok {
			t.Fatalf("WholeCommand deferral names %q, which is not in Commands; delete the stale entry", name)
		}
	}
}

// TestSubcommandSeamDeferralsMatchOwnershipFor verifies each registered
// SubcommandSeam actually resolves to the TypeScript owner today, and that the
// two map-driven families (models, lab) register every TypeScript-owned verb.
// This catches a stale registration after a subcommand flip (the OwnershipFor
// check goes red) and a new TS verb added to a runtime map without a ledger
// entry.
func TestSubcommandSeamDeferralsMatchOwnershipFor(t *testing.T) {
	for _, d := range deferredSurfaces {
		if d.Kind == SubcommandSeam {
			if d.Name == "" || d.Reason == "" {
				t.Fatalf("SubcommandSeam deferral %q must carry Name and Reason", d.Name)
			}
			for _, argv := range d.Surfaces() {
				owner, known := OwnershipFor(argv)
				if !known || owner != TypeScriptOwned {
					t.Fatalf(
						"registered SubcommandSeam %v is no longer TypeScript-owned "+
							"(OwnershipFor = %q, %t); delete or update the deferral entry",
						argv, owner, known)
				}
			}
		}
	}
	// The map-driven families enumerate their verbs in code, so the registry
	// covers them through the map rather than a hand-maintained list. Every
	// TypeScript-owned verb in each map must be attributable to a registered
	// seam so the ledger cannot drift from the maps.
	for family, verbs := range map[string]map[string]Ownership{
		"models": modelRuntimeSubcommands,
		"lab":    labRuntimeSubcommands,
	} {
		for verb, owner := range verbs {
			if owner != TypeScriptOwned {
				continue
			}
			if !seamCovers(family, []string{verb}) {
				t.Fatalf(
					"%s %s is TypeScriptOwned in the runtime map but no registered "+
						"SubcommandSeam deferral names it; register the seam", family, verb)
			}
		}
	}
}

func seamCovers(family string, verbs []string) bool {
	// A seam registered for the family with no verb list covers every verb
	// (map-driven families); a seam with explicit verbs must contain this one.
	for _, d := range deferredSurfaces {
		if d.Kind != SubcommandSeam || d.Name != family {
			continue
		}
		if len(d.Verbs) == 0 {
			return true
		}
		for _, v := range verbs {
			if !slices.Contains(d.Verbs, v) {
				return false
			}
		}
		return true
	}
	return false
}

// TestFamilyFallbackDelegationRegistered exercises the negative space of
// Fallback seams: a family whose default is to delegate everything outside its
// Go-native surface (config's non-map verbs, codex-shim's non-status verbs).
// A Fallback seam is the only ledger entry that can express that shape, so
// deleting it must fail, and the Go-native carve-outs it excludes must stay
// native.
func TestFamilyFallbackDelegationRegistered(t *testing.T) {
	nativeVerbs := map[string][]string{
		"config":     append(slices.Collect(maps.Keys(configRuntimeSubcommands)), "--json", "--source"),
		"codex-shim": {"status"},
	}
	for _, d := range deferredSurfaces {
		if d.Kind != SubcommandSeam || !d.Fallback {
			continue
		}
		native, ok := nativeVerbs[d.Name]
		if !ok {
			t.Fatalf("Fallback seam %q has no native-verb table in this test; add one", d.Name)
		}
		// The fallback itself: an unknown verb delegates to TypeScript.
		if owner, known := OwnershipFor([]string{d.Name, "__ocx_unknown_verb__"}); !known || owner != TypeScriptOwned {
			t.Fatalf("Fallback seam %q no longer delegates unknown verbs "+
				"(OwnershipFor = %q, %t); delete or update the deferral entry",
				d.Name, owner, known)
		}
		// The Go-native carve-out the fallback excludes must stay native.
		for _, verb := range native {
			if owner, known := OwnershipFor([]string{d.Name, verb}); !known || owner != GoOwned {
				t.Fatalf("Fallback seam %q lists %s as Go-native but "+
					"OwnershipFor = %q, %t", d.Name, verb, owner, known)
			}
		}
		delete(nativeVerbs, d.Name)
	}
	// Every family with a registered Fallback seam must appear in the table
	// above, and the test table must not name a family with no Fallback seam.
	for family := range nativeVerbs {
		t.Fatalf("native-verb table names %q but no Fallback seam is registered for it", family)
	}
}
