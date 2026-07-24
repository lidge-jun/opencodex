package combos

import (
	"encoding/json"
	"fmt"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// RewriteRequest replaces the virtual model with the selected concrete model and
// applies the combo default effort only when the caller omitted an effort.
func RewriteRequest(req *types.NormalizedRequest, pick *Pick, defaultEffort string) error {
	if req == nil || pick == nil || pick.Resolved == nil {
		return fmt.Errorf("combo request and pick are required")
	}
	req.ModelID = pick.Target.Model
	if req.Options.Reasoning == "" && defaultEffort != "" {
		req.Options.Reasoning = defaultEffort
	}
	if len(req.RawBody) == 0 {
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(req.RawBody, &body); err != nil {
		return fmt.Errorf("rewrite combo request body: %w", err)
	}
	body["model"] = pick.Target.Model
	if defaultEffort != "" {
		reasoning, _ := body["reasoning"].(map[string]any)
		_, hasLegacy := body["reasoning_effort"]
		_, hasEffort := reasoning["effort"]
		if !hasLegacy && !hasEffort {
			if reasoning == nil {
				reasoning = make(map[string]any)
				body["reasoning"] = reasoning
			}
			reasoning["effort"] = defaultEffort
		}
	}
	rewritten, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("rewrite combo request body: %w", err)
	}
	req.RawBody = rewritten
	return nil
}

// ResolveRequest selects a target and rewrites req for its adapter.
func (r *Resolver) ResolveRequest(req *types.NormalizedRequest) (*Pick, error) {
	if req == nil {
		return nil, fmt.Errorf("normalized request is required")
	}
	pick, err := r.PickTarget(req.ModelID)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	combo := r.combos[pick.ComboID]
	r.mu.Unlock()
	if err := RewriteRequest(req, pick, combo.DefaultEffort); err != nil {
		return nil, err
	}
	return pick, nil
}
