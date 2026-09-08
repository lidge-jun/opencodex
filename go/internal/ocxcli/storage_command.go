package ocxcli

// ocx storage — the archived-session cleanup, trash, and cleanup-policy
// surface (wp7). This file ports src/cli/storage.ts so the ownership flip keeps
// the documented surface identical; the differential harness diffs TS CLI
// output against this implementation for the same argv and the same live
// management server.
//
// Cleanup and restore MUTATE operator data and require --yes. Without --yes,
// cleanup prints the preview and changes nothing. `codex-logs` stays with the
// TypeScript observe owner (it is observe storage codex-logs spelled through
// the storage command), so storage codex-logs still delegates.

import (
	"fmt"
	"math"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const storageUsage = `Usage:
  ocx storage report [--json]
  ocx storage cleanup --percent <0-100> [--mode <quarantine|permanent>] [--yes] [--json]
  ocx storage trash [list] [--json]
  ocx storage trash restore <entry-id> [--yes] [--json]
  ocx storage policy [show] [--json]
  ocx storage policy set [--enabled <true|false>] [--percent <0-100>]
      [--mode <quarantine|permanent>] [--schedule <startup|daily|weekly|manual>] [--json]
  ocx storage policy run [--yes] [--json]

Cleanup and restore MUTATE operator data and require --yes.
Without --yes, cleanup prints the preview and changes nothing.`

// storageMib mirrors mib: MiB with one decimal via toFixed(1), or "unknown
// size" for a missing or non-finite byte count.
func storageMib(bytes float64, ok bool) string {
	if !ok || math.IsNaN(bytes) || math.IsInf(bytes, 0) {
		return "unknown size"
	}
	return fmt.Sprintf("%.1f MiB", bytes/1024/1024)
}

func storageNumberField(object *jsonwire.Value, key string) (float64, bool) {
	if object == nil || object.Kind() != jsonwire.Object {
		return 0, false
	}
	return jsonNumberOrNil(object.Find(key))
}

func storageStringField(object *jsonwire.Value, key string) (string, bool) {
	if object == nil || object.Kind() != jsonwire.Object {
		return "", false
	}
	return jsonStringOrNil(object.Find(key))
}

// storagePreviewLines mirrors previewLines over the cleanup-preview payload.
func storagePreviewLines(preview *jsonwire.Value) []string {
	count, countOK := storageNumberField(preview, "count")
	if !countOK {
		count = 0
	}
	_, bytesOK := storageNumberField(preview, "bytes")
	bytes, _ := storageNumberField(preview, "bytes")
	lines := []string{fmt.Sprintf("Would remove %s archived session file(s), freeing %s.",
		usageCount(count, countOK), storageMib(bytes, bytesOK))}
	candidates := 0
	if value := preview.Find("candidates"); value != nil && value.Kind() == jsonwire.Array {
		for _, candidate := range value.Elements() {
			if candidates >= 10 {
				break
			}
			relPath, ok := storageStringField(candidate, "relPath")
			name := "(unnamed)"
			if ok {
				name = relPath
			}
			cb, cok := storageNumberField(candidate, "bytes")
			lines = append(lines, fmt.Sprintf("  %s  %s", name, storageMib(cb, cok)))
			candidates++
		}
	}
	if count > float64(candidates) {
		lines = append(lines, fmt.Sprintf("  … and %s more", usageCount(count-float64(candidates), true)))
	}
	lines = append(lines, "Nothing was deleted. Re-run with --yes to apply.")
	return lines
}

// usageCount is defined in usage_command.go (formatENUS); alias for readability.
func storageCleanup(argv []string, deps Deps) error {
	args := append([]string(nil), argv...)
	wantsJSON := takeFlag(&args, "--json")
	confirmed := takeFlag(&args, "--yes")
	percent, percentGiven, err := takeIntegerOption(&args, "--percent", requiredIntMin(0))
	if err != nil {
		return err
	}
	mode, modeGiven, err := takeOption(&args, "--mode")
	if err != nil {
		return err
	}
	if !modeGiven {
		mode = "quarantine"
	}
	if err := managementRejectArgs(args, storageUsage, false); err != nil {
		return err
	}
	if !percentGiven {
		return usageErrorWith("--percent is required", storageUsage)
	}
	if percent > 100 {
		return usageErrorWith("--percent must be between 0 and 100", storageUsage)
	}
	if mode != "quarantine" && mode != "permanent" {
		return usageErrorWith("--mode must be quarantine or permanent", storageUsage)
	}

	// The preview runs in BOTH paths: the mutating route requires the digest this
	// call returns and rejects a stale one with 409 `stale_preview`.
	previewBody := jsonwire.ObjectValue()
	previewBody.Set("percent", jsonwire.NumberFrom(percent))
	preview, _, requestErr := familyManagementRequest(deps, "POST", "/api/storage/cleanup/preview", previewBody)
	if requestErr != nil {
		return requestErr
	}

	if !confirmed {
		familyPrintManagementData(deps, preview, wantsJSON, storagePreviewLines(preview))
		return nil
	}

	digest, hasDigest := storageStringField(preview, "digest")
	if !hasDigest || strings.TrimSpace(digest) == "" {
		return usageErrorWith("the preview returned no digest, so the cleanup cannot be authorized", storageUsage)
	}

	body := jsonwire.ObjectValue()
	body.Set("percent", jsonwire.NumberFrom(percent))
	body.Set("mode", jsonwire.StringValue(mode))
	body.Set("digest", jsonwire.StringValue(digest))
	result, _, requestErr := familyManagementRequest(deps, "POST", "/api/storage/cleanup", body)
	if requestErr != nil {
		return requestErr
	}
	familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
	return nil
}

func storageTrash(argv []string, deps Deps) error {
	action := "list"
	rest := append([]string(nil), argv...)
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		action = rest[0]
		rest = rest[1:]
	}

	if action == "list" {
		args := append([]string(nil), rest...)
		wantsJSON := takeFlag(&args, "--json")
		if err := managementRejectArgs(args, storageUsage, false); err != nil {
			return err
		}
		result, _, requestErr := familyManagementRequest(deps, "GET", "/api/storage/trash", nil)
		if requestErr != nil {
			return requestErr
		}
		familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}

	if action != "restore" {
		return usageErrorWith(fmt.Sprintf("unknown trash action %s", action), storageUsage)
	}
	args := append([]string(nil), rest...)
	wantsJSON := takeFlag(&args, "--json")
	confirmed := takeFlag(&args, "--yes")
	id := ""
	if len(args) > 0 {
		id = args[0]
		args = args[1:]
	}
	if err := managementRejectArgs(args, storageUsage, false); err != nil {
		return err
	}
	if id == "" {
		return usageErrorWith("a trash entry id is required", storageUsage)
	}
	if !confirmed {
		return usageErrorWith(fmt.Sprintf("restoring %s modifies stored sessions; pass --yes to confirm", id), storageUsage)
	}
	body := jsonwire.ObjectValue()
	body.Set("id", jsonwire.StringValue(id))
	result, _, requestErr := familyManagementRequest(deps, "POST", "/api/storage/trash/restore", body)
	if requestErr != nil {
		return requestErr
	}
	familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
	return nil
}

func storagePolicy(argv []string, deps Deps) error {
	action := "show"
	rest := append([]string(nil), argv...)
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		action = rest[0]
		rest = rest[1:]
	}

	if action == "show" {
		args := append([]string(nil), rest...)
		wantsJSON := takeFlag(&args, "--json")
		if err := managementRejectArgs(args, storageUsage, false); err != nil {
			return err
		}
		result, _, requestErr := familyManagementRequest(deps, "GET", "/api/storage/cleanup-policy", nil)
		if requestErr != nil {
			return requestErr
		}
		familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}

	if action == "set" {
		args := append([]string(nil), rest...)
		wantsJSON := takeFlag(&args, "--json")
		enabled, enabledGiven, err := takeOption(&args, "--enabled")
		if err != nil {
			return err
		}
		percent, percentGiven, err := takeIntegerOption(&args, "--percent", requiredIntMin(0))
		if err != nil {
			return err
		}
		mode, modeGiven, err := takeOption(&args, "--mode")
		if err != nil {
			return err
		}
		schedule, scheduleGiven, err := takeOption(&args, "--schedule")
		if err != nil {
			return err
		}
		if err := managementRejectArgs(args, storageUsage, false); err != nil {
			return err
		}
		if enabledGiven && enabled != "true" && enabled != "false" {
			return usageErrorWith("--enabled must be true or false", storageUsage)
		}
		body := jsonwire.ObjectValue()
		if enabledGiven {
			body.Set("enabled", jsonwire.BoolValue(enabled == "true"))
		}
		// The policy target is nested: a top-level `percent` is not part of the
		// PUT contract, so it is projected onto `target.removeOldestPercent`. An
		// out-of-range value is deliberately still sent: the server owns the
		// 1-100 vocabulary and answers with a named 400.
		if percentGiven {
			target := jsonwire.ObjectValue()
			target.Set("removeOldestPercent", jsonwire.NumberFrom(percent))
			body.Set("target", target)
		}
		if modeGiven {
			body.Set("mode", jsonwire.StringValue(mode))
		}
		if scheduleGiven {
			body.Set("schedule", jsonwire.StringValue(schedule))
		}
		if len(body.Members()) == 0 {
			return usageErrorWith("policy set needs at least one of --enabled, --percent, --mode, --schedule", storageUsage)
		}
		result, _, requestErr := familyManagementRequest(deps, "PUT", "/api/storage/cleanup-policy", body)
		if requestErr != nil {
			return requestErr
		}
		familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
		return nil
	}

	if action != "run" {
		return usageErrorWith(fmt.Sprintf("unknown policy action %s", action), storageUsage)
	}
	args := append([]string(nil), rest...)
	wantsJSON := takeFlag(&args, "--json")
	confirmed := takeFlag(&args, "--yes")
	if err := managementRejectArgs(args, storageUsage, false); err != nil {
		return err
	}
	if !confirmed {
		return usageErrorWith("policy run deletes archived sessions now; pass --yes to confirm", storageUsage)
	}
	result, _, requestErr := familyManagementRequest(deps, "POST", "/api/storage/cleanup-policy/run", nil)
	if requestErr != nil {
		return requestErr
	}
	familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
	return nil
}

// runStorage implements `ocx storage`. It assumes the caller validated
// ownership; argv carries only this command's own arguments.
func runStorage(args []string, deps Deps) int {
	return runManagementAction(deps, func() error {
		sub := "report"
		rest := append([]string(nil), args...)
		if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
			sub = rest[0]
			rest = rest[1:]
		}
		switch sub {
		case "report":
			wantsJSON := takeFlag(&rest, "--json")
			if err := managementRejectArgs(rest, storageUsage, false); err != nil {
				return err
			}
			result, _, requestErr := familyManagementRequest(deps, "GET", "/api/storage", nil)
			if requestErr != nil {
				return requestErr
			}
			familyPrintManagementData(deps, result, wantsJSON, managementSummaryLines(result, "", 0))
			return nil
		case "cleanup":
			return storageCleanup(rest, deps)
		case "trash":
			return storageTrash(rest, deps)
		case "policy":
			return storagePolicy(rest, deps)
		default:
			return usageErrorWith(fmt.Sprintf("unknown storage command %s", sub), storageUsage)
		}
	})
}

// storageHelp mirrors the TypeScript registry entry for `ocx help storage`
// (usage + summary + details), byte for byte.
const storageHelp = "Usage: ocx storage <report|cleanup|trash|policy> ...\n" +
	"\n" +
	"Storage report, archived-session cleanup, trash restore, and the cleanup policy.\n" +
	"\n" +
	"A bare `ocx storage` prints the report, as it did when this was an alias of `observe storage`.\n" +
	"`cleanup` previews by default and only deletes under --yes; `trash restore` and `policy run` also require --yes.\n"
