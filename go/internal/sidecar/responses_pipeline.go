package sidecar

// Ordered client-facing Responses repairs shared by bounded JSON and SSE
// relays. The order mirrors handleResponses' payload rewrite composition:
// representation restores, model/reasoning normalization, then canonical
// field backfill. Each step is deliberately no-op when its input is absent.

import (
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

type responseRepairPipeline struct {
	modelID      string
	imageAliases map[string]imageAlias
	reasoning    bool
}

type imageAlias struct{ name, namespace string }

func (p responseRepairPipeline) repairJSON(raw []byte) ([]byte, bool) {
	root, err := jsonwire.Parse(raw)
	if err != nil || root.Kind() != jsonwire.Object {
		return raw, false
	}
	changed := false
	if p.modelID != "" {
		changed = rewriteModelField(root, p.modelID)
		if response := root.Find("response"); response != nil {
			changed = rewriteModelField(response, p.modelID) || changed
		}
	}
	changed = p.repairValue(root) || changed
	changed = backfillResponsesJSON(root) || changed
	if !changed {
		return raw, false
	}
	encoded, err := root.Encode()
	if err != nil {
		return raw, false
	}
	return encoded, true
}

func (p responseRepairPipeline) repairValue(v *jsonwire.Value) bool {
	if v == nil {
		return false
	}
	changed := false
	// Model payload rewrite applies to the event/response object pair only;
	// walking nested output items must not rewrite an unrelated model field.
	if p.modelID != "" && v.Kind() == jsonwire.Object {
		changed = rewriteModelField(v, p.modelID)
		if response := v.Find("response"); response != nil {
			changed = rewriteModelField(response, p.modelID) || changed
		}
	}
	switch v.Kind() {
	case jsonwire.Array:
		for _, e := range v.Elements() {
			changed = p.repairValue(e) || changed
		}
	case jsonwire.Object:
		if typ, ok := stringMember(v, "type"); ok {
			if p.reasoning && typ == "response.reasoning_text.delta" {
				v.Set("type", jsonwire.StringValue("response.reasoning_summary_text.delta"))
				if v.Find("summary_index") == nil {
					v.Set("summary_index", jsonwire.NumberFrom(0))
				}
				changed = true
			} else if p.reasoning && typ == "response.reasoning_text.done" {
				v.Set("type", jsonwire.StringValue("response.reasoning_summary_text.done"))
				if v.Find("summary_index") == nil {
					v.Set("summary_index", jsonwire.NumberFrom(0))
				}
				changed = true
			}
		}
		// Image-gen aliases are representation-only and are restored before
		// all structural repairs, matching the TS payload rewrite list.
		if typ, ok := stringMember(v, "type"); ok && typ == "function_call" {
			if name, ok := stringMember(v, "name"); ok {
				if alias, found := p.imageAliases[name]; found {
					v.Set("name", jsonwire.StringValue(alias.name))
					v.Set("namespace", jsonwire.StringValue(alias.namespace))
					changed = true
				}
			}
		}
		if p.reasoning {
			changed = p.repairReasoningItem(v) || changed
		}
		for _, m := range v.Members() {
			changed = p.repairValue(m.Value) || changed
		}
	}
	return changed
}

func rewriteModelField(v *jsonwire.Value, modelID string) bool {
	if v == nil || v.Kind() != jsonwire.Object {
		return false
	}
	model, ok := stringMember(v, "model")
	if !ok || model == modelID {
		return false
	}
	v.Set("model", jsonwire.StringValue(modelID))
	return true
}

func (p responseRepairPipeline) repairReasoningItem(v *jsonwire.Value) bool {
	typ, ok := stringMember(v, "type")
	if !ok || typ != "reasoning" {
		return false
	}
	content := v.Find("content")
	if content == nil || content.Kind() != jsonwire.Array {
		return false
	}
	var text strings.Builder
	for _, part := range content.Elements() {
		if partType, ok := stringMember(part, "type"); ok && partType == "reasoning_text" {
			if t, ok := stringMember(part, "text"); ok {
				text.WriteString(t)
			}
		}
	}
	if text.Len() == 0 || v.Find("encrypted_content") != nil {
		return false
	}
	v.Delete("content")
	summary := jsonwire.EmptyArray()
	part := jsonwire.ObjectValue()
	part.Set("type", jsonwire.StringValue("summary_text"))
	part.Set("text", jsonwire.StringValue(text.String()))
	summary.AppendArray(part)
	v.Set("summary", summary)
	return true
}

func imageAliasesFromRequest(root *jsonwire.Value) map[string]imageAlias {
	out := map[string]imageAlias{}
	tools := root.Find("tools")
	if tools == nil || tools.Kind() != jsonwire.Array {
		return out
	}
	for _, tool := range tools.Elements() {
		if tool == nil || tool.Kind() != jsonwire.Object {
			continue
		}
		name, ok := stringMember(tool, "name")
		if !ok {
			continue
		}
		if strings.HasPrefix(name, "image_gen.") && len(name) > len("image_gen.") {
			local := strings.TrimPrefix(name, "image_gen.")
			out[name] = imageAlias{name: local, namespace: "image_gen"}
			out["image_gen__"+local] = imageAlias{name: local, namespace: "image_gen"}
		}
	}
	return out
}
