package sidecar

// Stateful Responses repairs. Both repair objects are owned by one
// ResponsesSSEStream: their maps are deliberately request-local, just as the
// TypeScript payload/block rewrite closures are. Nothing here survives an SSE
// stream or leaks synthetic client ids into continuation state.

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strconv"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

type itemIDRepairConfig struct {
	message, reasoning map[string]bool
	missing, invalid   bool
}

func itemIDRepairConfigFromProvider(provider *jsonwire.Value) (itemIDRepairConfig, bool) {
	raw := provider.Find("responsesItemIdRepair")
	if raw == nil || raw.Kind() != jsonwire.Object {
		return itemIDRepairConfig{}, false
	}
	c := itemIDRepairConfig{message: map[string]bool{}, reasoning: map[string]bool{}}
	c.missing, _ = boolMember(raw, "repairMissingTerminalIds")
	c.invalid, _ = boolMember(raw, "repairInvalidIds")
	for _, row := range []struct {
		key  string
		into map[string]bool
	}{{"message", c.message}, {"reasoning", c.reasoning}} {
		if values := raw.Find(row.key); values != nil && values.Kind() == jsonwire.Array {
			for _, value := range values.Elements() {
				if value != nil && value.Kind() == jsonwire.String && value.String() != "" {
					row.into[value.String()] = true
				}
			}
		}
	}
	return c, c.missing || c.invalid || len(c.message) > 0 || len(c.reasoning) > 0
}

type itemIDRepairState struct {
	config itemIDRepairConfig
	scope  string
	output map[string]map[string]string // item type -> output_index -> canonical id
	raw    map[string]string            // output_index + NUL + upstream id -> canonical id
}

func newItemIDRepairState(config itemIDRepairConfig) *itemIDRepairState {
	seed := make([]byte, 16)
	if _, err := rand.Read(seed); err != nil { // crypto/rand failure must not make ids collide across streams.
		seed = []byte(strconv.FormatInt(syntheticSSEItemOrdinal.Add(1), 10))
	}
	return &itemIDRepairState{config: config, scope: hex.EncodeToString(seed), output: map[string]map[string]string{"message": {}, "reasoning": {}}, raw: map[string]string{}}
}

func repairableItemType(v *jsonwire.Value) (string, bool) {
	t, ok := stringMember(v, "type")
	return t, ok && (t == "message" || t == "reasoning")
}
func canonicalItemID(typ, scope, index string) string {
	prefix := "msg_"
	if typ == "reasoning" {
		prefix = "rs_"
	}
	return prefix + "ocx_" + scope + "_" + index
}
func itemRawKey(index, id string) string { return index + "@" + id }

// remember maps an item only when the TypeScript policy would map it. A valid
// existing id is remembered only for missing-terminal-id repair; that enables
// a later id-less terminal event without rewriting the item itself.
func (s *itemIDRepairState) remember(index string, item *jsonwire.Value) string {
	typ, ok := repairableItemType(item)
	if !ok {
		return ""
	}
	if got := s.output[typ][index]; got != "" {
		return got
	}
	raw, ok := stringMember(item, "id")
	if !ok || raw == "" {
		return ""
	}
	placeholders := s.config.message
	if typ == "reasoning" {
		placeholders = s.config.reasoning
	}
	mapped := ""
	if placeholders[raw] || (s.config.invalid && !hasPrefixForItem(typ, raw)) {
		mapped = canonicalItemID(typ, s.scope, index)
	} else if s.config.missing {
		mapped = raw
	}
	if mapped == "" {
		return ""
	}
	s.output[typ][index] = mapped
	if mapped != raw {
		s.raw[itemRawKey(index, raw)] = mapped
	}
	return mapped
}
func hasPrefixForItem(typ, id string) bool {
	return (typ == "message" && len(id) >= 4 && id[:4] == "msg_") || (typ == "reasoning" && len(id) >= 3 && id[:3] == "rs_")
}

func (s *itemIDRepairState) rewriteItem(index string, item *jsonwire.Value) bool {
	mapped := s.remember(index, item)
	if mapped == "" {
		return false
	}
	current, present := stringMember(item, "id")
	if (present && current == mapped) || (!present && !s.config.missing) {
		return false
	}
	item.Set("id", jsonwire.StringValue(mapped))
	return true
}
func (s *itemIDRepairState) rewriteEvent(event *jsonwire.Value) bool {
	index, ok := sseOutputIndex(event.Find("output_index"))
	changed := false
	if ok {
		if item := event.Find("item"); item != nil && item.Kind() == jsonwire.Object {
			changed = s.rewriteItem(index, item)
		}
		if current, has := stringMember(event, "item_id"); has {
			if mapped := s.raw[itemRawKey(index, current)]; mapped != "" && mapped != current {
				event.Set("item_id", jsonwire.StringValue(mapped))
				changed = true
			}
		} else if s.config.missing {
			typ := itemEventType(event)
			if typ != "" {
				if mapped := s.output[typ][index]; mapped != "" {
					event.Set("item_id", jsonwire.StringValue(mapped))
					changed = true
				}
			}
		}
	}
	if response := event.Find("response"); response != nil && response.Kind() == jsonwire.Object {
		if output := response.Find("output"); output != nil && output.Kind() == jsonwire.Array {
			for i, item := range output.Elements() {
				changed = s.rewriteItem(itoa(i), item) || changed
			}
		}
	}
	return changed
}
func itemEventType(event *jsonwire.Value) string {
	t, _ := stringMember(event, "type")
	switch t {
	case "response.content_part.added", "response.content_part.done", "response.output_text.annotation.added", "response.output_text.delta", "response.output_text.done", "response.refusal.delta", "response.refusal.done":
		return "message"
	case "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "response.reasoning_text.delta", "response.reasoning_text.done":
		return "reasoning"
	}
	return ""
}

// Snapshot repair carries only the state required to close sparse message
// lifecycles. Existing upstream output-item.done is authoritative; synthesis
// happens only at response.completed and only for a proven open message.
type snapshotOpenItem struct {
	id, index                       string
	typ                             string
	injectable                      bool
	item                            *jsonwire.Value
	text                            string
	contentOpen, textDone, partDone bool
}
type snapshotRepairState struct {
	enabled   bool
	open      map[string]*snapshotOpenItem
	completed map[string]*jsonwire.Value
	tainted   bool
	parallel  bool
	choice    *jsonwire.Value
	tools     *jsonwire.Value
}

const (
	maxSnapshotOpenItems = 10_000
	maxSnapshotTextBytes = 8 * 1024 * 1024
)

func newSnapshotRepairState(enabled bool, request *jsonwire.Value) *snapshotRepairState {
	s := &snapshotRepairState{enabled: enabled, open: map[string]*snapshotOpenItem{}, completed: map[string]*jsonwire.Value{}, parallel: true}
	if request == nil || request.Kind() != jsonwire.Object {
		return s
	}
	if value := request.Find("parallel_tool_calls"); value != nil && value.Kind() == jsonwire.Bool {
		s.parallel = value.Bool()
	}
	if value := request.Find("tool_choice"); snapshotToolChoiceValid(value) {
		s.choice = value
	}
	if value := request.Find("tools"); value != nil && value.Kind() == jsonwire.Array {
		s.tools = value
	}
	return s
}

func snapshotToolChoiceValid(value *jsonwire.Value) bool {
	if value == nil {
		return false
	}
	if value.Kind() == jsonwire.String {
		return value.String() != ""
	}
	if value.Kind() == jsonwire.Object {
		typ, ok := stringMember(value, "type")
		return ok && typ != ""
	}
	return false
}

func (s *snapshotRepairState) rewrite(event *jsonwire.Value) ([]*jsonwire.Value, bool) {
	if !s.enabled {
		return nil, false
	}
	typ, _ := stringMember(event, "type")
	changed := false
	if response := event.Find("response"); response != nil && response.Kind() == jsonwire.Object {
		changed = s.repairResponse(response, snapshotResponseStatus(typ)) || changed
	}
	index, validIndex := sseOutputIndex(event.Find("output_index"))
	if typ == "response.output_item.added" && validIndex {
		if item := event.Find("item"); item != nil && item.Kind() == jsonwire.Object {
			changed = snapshotRepairOutputItem(item, "in_progress") || changed
			if s.open[index] != nil {
				s.taint()
			}
			if len(s.open) >= maxSnapshotOpenItems {
				s.taint()
			}
			if id, ok := stringMember(item, "id"); ok && id != "" {
				kind, _ := stringMember(item, "type")
				if !s.tainted {
					s.open[index] = &snapshotOpenItem{id: id, index: index, typ: kind, injectable: kind == "message" || kind == "reasoning", item: item}
				}
			} else {
				s.taint()
			}
		}
	}
	if typ == "response.output_item.done" && validIndex {
		if item := event.Find("item"); item != nil && item.Kind() == jsonwire.Object {
			changed = snapshotRepairOutputItem(item, "completed") || changed
			if open := s.open[index]; open != nil {
				doneID, idOK := stringMember(item, "id")
				doneType, typeOK := stringMember(item, "type")
				if !idOK || !typeOK || doneID != open.id || doneType != open.typ {
					s.taint()
				} else if !s.tainted {
					s.completed[index] = item
					delete(s.open, index)
				}
			} else if !s.tainted {
				s.taint()
			}
		} else {
			s.taint()
		}
	}
	if open := s.open[index]; validIndex && open != nil {
		itemID, hasItemID := stringMember(event, "item_id")
		if hasItemID && itemID != open.id {
			s.taint()
			return nil, changed
		}
		if typ == "response.content_part.added" {
			open.contentOpen = true
		}
		if typ == "response.content_part.done" {
			open.partDone = true
		}
		if typ == "response.output_text.delta" && open.typ == "message" {
			if logprobs := event.Find("logprobs"); logprobs == nil || logprobs.Kind() != jsonwire.Array {
				event.Set("logprobs", jsonwire.EmptyArray())
				changed = true
			}
			if text, ok := stringMember(event, "delta"); ok {
				open.text += text
				if len(open.text) > maxSnapshotTextBytes {
					s.taint()
					return nil, changed
				}
			}
			if !open.contentOpen {
				open.contentOpen = true
				return []*jsonwire.Value{snapshotContentAdded(open)}, changed
			}
		}
		if typ == "response.output_text.done" && open.typ == "message" {
			if logprobs := event.Find("logprobs"); logprobs == nil || logprobs.Kind() != jsonwire.Array {
				event.Set("logprobs", jsonwire.EmptyArray())
				changed = true
			}
			open.textDone = true
			if text, ok := stringMember(event, "text"); ok {
				open.text = text
				if len(open.text) > maxSnapshotTextBytes {
					s.taint()
					return nil, changed
				}
			}
		}
	}
	if typ == "response.content_part.added" || typ == "response.content_part.done" || typ == "response.reasoning_summary_part.added" || typ == "response.reasoning_summary_part.done" {
		changed = snapshotRepairPart(event.Find("part")) || changed
	}
	if typ != "response.completed" {
		return nil, changed
	}
	if s.tainted {
		return nil, changed
	}
	keys := make([]string, 0, len(s.open))
	for index := range s.open {
		keys = append(keys, index)
	}
	sort.Slice(keys, func(i, j int) bool {
		left, _ := strconv.ParseFloat(keys[i], 64)
		right, _ := strconv.ParseFloat(keys[j], 64)
		return left < right
	})
	var injected []*jsonwire.Value
	canReconstruct := true
	for _, index := range keys {
		open := s.open[index]
		if !open.injectable {
			canReconstruct = false
			continue
		}
		if open.typ == "message" && !open.contentOpen {
			injected = append(injected, snapshotContentAdded(open))
		}
		if open.typ == "message" && !open.textDone {
			injected = append(injected, snapshotTextDone(open))
		}
		if open.typ == "message" && !open.partDone {
			injected = append(injected, snapshotPartDone(open))
		}
		injected = append(injected, snapshotItemDone(open))
		s.completed[index] = snapshotCompletedItem(open)
	}
	if response := event.Find("response"); canReconstruct && response != nil && response.Kind() == jsonwire.Object {
		if output := response.Find("output"); output == nil || output.Kind() != jsonwire.Array {
			ordered := make([]string, 0, len(s.completed))
			for index := range s.completed {
				ordered = append(ordered, index)
			}
			sort.Slice(ordered, func(i, j int) bool {
				left, _ := strconv.ParseFloat(ordered[i], 64)
				right, _ := strconv.ParseFloat(ordered[j], 64)
				return left < right
			})
			contiguous := true
			for position, index := range ordered {
				value, err := strconv.ParseFloat(index, 64)
				if err != nil || value != float64(position) {
					contiguous = false
					break
				}
			}
			if contiguous {
				output = jsonwire.EmptyArray()
				for _, index := range ordered {
					output.AppendArray(s.completed[index])
				}
				response.Set("output", output)
				changed = true
			}
		}
	}
	s.open = map[string]*snapshotOpenItem{}
	s.completed = map[string]*jsonwire.Value{}
	return injected, changed
}

func (s *snapshotRepairState) taint() {
	s.open = map[string]*snapshotOpenItem{}
	s.completed = map[string]*jsonwire.Value{}
	s.tainted = true
}

func snapshotResponseStatus(typ string) string {
	switch typ {
	case "response.created", "response.in_progress":
		return "in_progress"
	case "response.queued":
		return "queued"
	case "response.failed":
		return "failed"
	case "response.incomplete":
		return "incomplete"
	}
	return "completed"
}

func (s *snapshotRepairState) repairResponse(response *jsonwire.Value, fallback string) bool {
	changed := false
	if status, ok := stringMember(response, "status"); !ok || status == "" {
		response.Set("status", jsonwire.StringValue(fallback))
		changed = true
	}
	if value := response.Find("parallel_tool_calls"); value == nil || value.Kind() != jsonwire.Bool {
		response.Set("parallel_tool_calls", jsonwire.BoolValue(s.parallel))
		changed = true
	}
	if !snapshotToolChoiceValid(response.Find("tool_choice")) {
		if s.choice != nil {
			response.Set("tool_choice", s.choice)
		} else {
			response.Set("tool_choice", jsonwire.StringValue("auto"))
		}
		changed = true
	}
	if value := response.Find("tools"); value == nil || value.Kind() != jsonwire.Array {
		if s.tools != nil {
			response.Set("tools", s.tools)
		} else {
			response.Set("tools", jsonwire.EmptyArray())
		}
		changed = true
	}
	if output := response.Find("output"); output != nil && output.Kind() == jsonwire.Array {
		status, _ := stringMember(response, "status")
		inferred, _ := responseStatusToItemStatus(status)
		for i, item := range output.Elements() {
			changed = backfillSSEOutputItem(item, itoa(i), inferred) || changed
		}
	}
	return changed
}

func snapshotRepairOutputItem(item *jsonwire.Value, status string) bool {
	if item == nil || item.Kind() != jsonwire.Object {
		return false
	}
	kind, _ := stringMember(item, "type")
	changed := false
	if kind == "message" {
		if role, ok := stringMember(item, "role"); !ok || role != "assistant" {
			item.Set("role", jsonwire.StringValue("assistant"))
			changed = true
		}
		if content := item.Find("content"); content == nil || content.Kind() != jsonwire.Array {
			item.Set("content", jsonwire.EmptyArray())
			changed = true
		} else {
			for _, part := range content.Elements() {
				changed = snapshotRepairPart(part) || changed
			}
		}
	} else if kind == "reasoning" {
		if summary := item.Find("summary"); summary == nil || summary.Kind() != jsonwire.Array {
			item.Set("summary", jsonwire.EmptyArray())
			changed = true
		} else {
			for _, part := range summary.Elements() {
				changed = snapshotRepairPart(part) || changed
			}
		}
	}
	if status != "" {
		if current, ok := stringMember(item, "status"); !ok || current == "" {
			item.Set("status", jsonwire.StringValue(status))
			changed = true
		}
	}
	return changed
}

func snapshotRepairPart(part *jsonwire.Value) bool {
	if part == nil || part.Kind() != jsonwire.Object {
		return false
	}
	typ, _ := stringMember(part, "type")
	changed := false
	if typ == "output_text" {
		if text := part.Find("text"); text == nil || text.Kind() != jsonwire.String {
			part.Set("text", jsonwire.StringValue(""))
			changed = true
		}
		if annotations := part.Find("annotations"); annotations == nil || annotations.Kind() != jsonwire.Array {
			part.Set("annotations", jsonwire.EmptyArray())
			changed = true
		}
	}
	if typ == "summary_text" {
		if text := part.Find("text"); text == nil || text.Kind() != jsonwire.String {
			part.Set("text", jsonwire.StringValue(""))
			changed = true
		}
	}
	return changed
}
func snapshotEvent(typ string, open *snapshotOpenItem) *jsonwire.Value {
	v := jsonwire.ObjectValue()
	v.Set("type", jsonwire.StringValue(typ))
	v.Set("item_id", jsonwire.StringValue(open.id))
	v.Set("output_index", jsonwire.NumberFrom(mustParseIndex(open.index)))
	v.Set("content_index", jsonwire.NumberFrom(0))
	return v
}
func mustParseIndex(index string) float64 { n, _ := strconv.ParseFloat(index, 64); return n }
func snapshotPart(text string) *jsonwire.Value {
	p := jsonwire.ObjectValue()
	p.Set("type", jsonwire.StringValue("output_text"))
	p.Set("text", jsonwire.StringValue(text))
	p.Set("annotations", jsonwire.EmptyArray())
	return p
}
func snapshotContentAdded(o *snapshotOpenItem) *jsonwire.Value {
	v := snapshotEvent("response.content_part.added", o)
	v.Set("part", snapshotPart(""))
	return v
}
func snapshotTextDone(o *snapshotOpenItem) *jsonwire.Value {
	v := snapshotEvent("response.output_text.done", o)
	v.Set("logprobs", jsonwire.EmptyArray())
	v.Set("text", jsonwire.StringValue(o.text))
	return v
}
func snapshotPartDone(o *snapshotOpenItem) *jsonwire.Value {
	v := snapshotEvent("response.content_part.done", o)
	v.Set("part", snapshotPart(o.text))
	return v
}
func snapshotItemDone(o *snapshotOpenItem) *jsonwire.Value {
	v := jsonwire.ObjectValue()
	v.Set("type", jsonwire.StringValue("response.output_item.done"))
	v.Set("output_index", jsonwire.NumberFrom(mustParseIndex(o.index)))
	item := jsonwire.ObjectValue()
	item.Set("type", jsonwire.StringValue(o.typ))
	item.Set("id", jsonwire.StringValue(o.id))
	item.Set("status", jsonwire.StringValue("completed"))
	if o.typ == "message" {
		item.Set("role", jsonwire.StringValue("assistant"))
		content := jsonwire.EmptyArray()
		content.AppendArray(snapshotPart(o.text))
		item.Set("content", content)
	} else {
		item.Set("summary", jsonwire.EmptyArray())
	}
	v.Set("item", item)
	return v
}

func snapshotCompletedItem(o *snapshotOpenItem) *jsonwire.Value {
	if o.typ == "reasoning" {
		item := jsonwire.ObjectValue()
		item.Set("type", jsonwire.StringValue("reasoning"))
		item.Set("id", jsonwire.StringValue(o.id))
		item.Set("status", jsonwire.StringValue("completed"))
		item.Set("summary", jsonwire.EmptyArray())
		return item
	}
	return snapshotItemDone(o).Find("item")
}

// repairJSON mirrors repairResponsesSnapshotJson: output is canonicalized to
// [] when absent or malformed, request defaults are copied into the response,
// and present output items receive the same field repair as streamed snapshots.
func (s *snapshotRepairState) repairJSON(root *jsonwire.Value) bool {
	if root == nil || root.Kind() != jsonwire.Object {
		return false
	}
	changed := false
	if output := root.Find("output"); output == nil || output.Kind() != jsonwire.Array {
		root.Set("output", jsonwire.EmptyArray())
		changed = true
	}
	if value := root.Find("parallel_tool_calls"); value == nil || value.Kind() != jsonwire.Bool {
		root.Set("parallel_tool_calls", jsonwire.BoolValue(s.parallel))
		changed = true
	}
	if !snapshotToolChoiceValid(root.Find("tool_choice")) {
		if s.choice != nil {
			root.Set("tool_choice", s.choice)
		} else {
			root.Set("tool_choice", jsonwire.StringValue("auto"))
		}
		changed = true
	}
	if value := root.Find("tools"); value == nil || value.Kind() != jsonwire.Array {
		if s.tools != nil {
			root.Set("tools", s.tools)
		} else {
			root.Set("tools", jsonwire.EmptyArray())
		}
		changed = true
	}
	if status, ok := stringMember(root, "status"); !ok || status == "" {
		root.Set("status", jsonwire.StringValue("completed"))
		changed = true
	}
	status, _ := stringMember(root, "status")
	inferred, _ := responseStatusToItemStatus(status)
	if output := root.Find("output"); output != nil && output.Kind() == jsonwire.Array {
		for _, item := range output.Elements() {
			changed = snapshotRepairOutputItem(item, inferred) || changed
		}
	}
	return changed
}
