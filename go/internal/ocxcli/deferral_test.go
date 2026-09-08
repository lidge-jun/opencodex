package ocxcli

import (
	"slices"
	"testing"
)

// deferral_test.go is the hard boundary for the TypeScript delegation seam
// (issue #55): every command surface that still routes through
// DelegateToTypeScript must be registered in deferredSurfaces with a reason,
// and no registered surface may outlive its flip. Together with
// TestOwnershipMapMatchesDispatch (top-level dispatch behavior) this keeps the
// seam explicit: a command cannot become TypeScript-owned by accident, a
// registration cannot silently go stale, and a new delegated verb inside a
// Go-owned family must enter the ledger.

// TestEveryTypeScriptOwnedTopLevelIsRegistered asserts the Commands table and
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
