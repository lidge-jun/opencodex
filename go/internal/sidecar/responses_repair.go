package sidecar

// Whole-body JSON field backfill for the data-plane relay (ticket #27, devlog
// 036). The TypeScript bounded-JSON passthrough path repairs a completed
// Responses object before the client sees it:
//
//   - output_text content parts missing `annotations` get `annotations: []`;
//   - output items missing (or empty-string) `id` get a synthetic
//     `<type-prefix>_ocx_<output-index>` id;
//   - message items missing `status` get one derived from the response's own
//     status.
//
// The transform is the mirror of
// src/server/responses/responses-field-backfill.ts (backfillResponsesFieldsJson)
// and is pinned byte-for-byte by unit tests against payloads captured from the
// TypeScript oracle. It only re-serialises the document when something changed;
// an untouched document must be relayed as the original raw bytes, exactly like
// the TS path.

import (
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// responsesItemIDPrefixes mirrors ITEM_ID_PREFIXES in the TS field-backfill
// module. The generic `item_` prefix is the fallback for unknown item types;
// compaction items are excluded from the backfill entirely (their contract has
// no id).
var responsesItemIDPrefixes = map[string]string{
	"message":               "msg_",
	"reasoning":             "rs_",
	"function_call":         "fc_",
	"custom_tool_call":      "ctc_",
	"tool_search_call":      "tsc_",
	"web_search_call":       "ws_",
	"file_search_call":      "fs_",
	"code_interpreter_call": "ci_",
	"computer_call":         "cc_",
	"image_generation_call": "ig_",
	"image_gen_call":        "ig_",
}

var compactionItemTypes = map[string]bool{
	"compaction":         true,
	"compaction_summary": true,
	"context_compaction": true,
}

// responseStatusToItemStatus mirrors messageStatusFromResponseStatus: a valid
// OutputMessage status passes through, queued becomes in_progress, and
// failed/cancelled map to incomplete. Anything else reports no inference.
func responseStatusToItemStatus(status string) (string, bool) {
	switch status {
	case "in_progress", "completed", "incomplete":
		return status, true
	case "queued":
		return "in_progress", true
	case "failed", "cancelled":
		return "incomplete", true
	}
	return "", false
}

// backfillOutputTextPart adds annotations: [] to an output_text content part
// when the key is absent. Returns the same node when nothing changed.
func backfillOutputTextPart(part *jsonwire.Value) (*jsonwire.Value, bool) {
	if part == nil || part.Kind() != jsonwire.Object {
		return part, false
	}
	if part.Find("annotations") != nil {
		return part, false
	}
	typeName, _ := stringMember(part, "type")
	if typeName != "output_text" {
		return part, false
	}
	part.Set("annotations", jsonwire.EmptyArray())
	return part, true
}

// stringMember reads an object member as a string.
func stringMember(obj *jsonwire.Value, key string) (string, bool) {
	if obj == nil || obj.Kind() != jsonwire.Object {
		return "", false
	}
	member := obj.Find(key)
	if member == nil || member.Kind() != jsonwire.String {
		return "", false
	}
	return member.String(), true
}

// backfillContentArray walks an item's content array and repairs output_text
// parts. Mirrors backfillContentArray: non-array content and non-object parts
// pass through untouched.
func backfillContentArray(content *jsonwire.Value) bool {
	if content == nil || content.Kind() != jsonwire.Array {
		return false
	}
	changed := false
	for _, part := range content.Elements() {
		if _, ok := backfillOutputTextPart(part); ok {
			changed = true
		}
	}
	return changed
}

// backfillItemID adds a synthetic <prefix>_ocx_<index> id to an output item
// when its id is absent or an empty string. Mirrors backfillItemId: a
// non-string id is treated as absent, exactly like the TS typeof check.
func backfillItemID(item *jsonwire.Value, index int) bool {
	if item == nil || item.Kind() != jsonwire.Object {
		return false
	}
	if id := item.Find("id"); id != nil {
		if id.Kind() == jsonwire.String && id.String() != "" {
			return false
		}
	}
	typeName, _ := stringMember(item, "type")
	prefix, known := responsesItemIDPrefixes[typeName]
	if !known {
		prefix = "item_"
	}
	item.Set("id", jsonwire.StringValue(prefix+"ocx_"+itoa(index)))
	return true
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var buf [20]byte
	pos := len(buf)
	for value > 0 {
		pos--
		buf[pos] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// backfillItemStatus adds a status to a message item when absent.
func backfillItemStatus(item *jsonwire.Value, inferred string) bool {
	if item == nil || item.Kind() != jsonwire.Object {
		return false
	}
	if item.Find("status") != nil {
		return false
	}
	typeName, _ := stringMember(item, "type")
	if typeName != "message" {
		return false
	}
	item.Set("status", jsonwire.StringValue(inferred))
	return true
}

// backfillOutputItem repairs one output item in place: content parts, then id,
// then status. Compaction items are excluded (their shape has no required id).
func backfillOutputItem(item *jsonwire.Value, index int, inferredStatus string) bool {
	if item == nil || item.Kind() != jsonwire.Object {
		return false
	}
	typeName, _ := stringMember(item, "type")
	if compactionItemTypes[typeName] {
		return false
	}
	changed := false
	changed = backfillContentArray(item.Find("content")) || changed
	changed = backfillItemID(item, index) || changed
	changed = backfillItemStatus(item, inferredStatus) || changed
	return changed
}

// backfillResponsesJSON applies the whole-body field backfill to a parsed
// Responses object. The status inference mirrors the TS JSON path: the
// response's own status when it maps to an OutputMessage status, else
// "completed". Returns true when any node changed (the caller must then
// re-serialise the tree).
func backfillResponsesJSON(root *jsonwire.Value) bool {
	if root == nil || root.Kind() != jsonwire.Object {
		return false
	}
	inferred := "completed"
	if rawStatus, ok := stringMember(root, "status"); ok {
		if mapped, ok := responseStatusToItemStatus(rawStatus); ok {
			inferred = mapped
		}
	}
	output := root.Find("output")
	if output == nil || output.Kind() != jsonwire.Array {
		return false
	}
	changed := false
	for index, item := range output.Elements() {
		changed = backfillOutputItem(item, index, inferred) || changed
	}
	return changed
}

// RepairResponsesJSONBody is the entry point for the relay: parse the upstream
// JSON body, apply the field backfill, and return the bytes the client must
// see. The changed flag distinguishes "raw relay" (nothing changed) from
// "re-serialise" (JSON.stringify semantics), mirroring the TS bounded-JSON
// path. A body that is not a JSON object is passed through unchanged with
// changed=false so the caller relays the original bytes.
func RepairResponsesJSONBody(raw []byte) (out []byte, changed bool) {
	root, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		return raw, false
	}
	if !backfillResponsesJSON(root) {
		return raw, false
	}
	encoded, encodeErr := root.Encode()
	if encodeErr != nil {
		return raw, false
	}
	return encoded, true
}
