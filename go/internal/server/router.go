package server

import (
	"fmt"

	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// ModelRouter resolves public selectors through the canonical registry.
type ModelRouter struct {
	Registry types.Registry
	Combos   *combos.Resolver
}

func (r ModelRouter) Resolve(selector string) (*types.ResolvedModel, error) {
	if r.Registry == nil {
		return nil, fmt.Errorf("model registry is not configured")
	}
	return r.Registry.ResolveModel(selector)
}

// ResolveRequest resolves and rewrites combo requests before adapter selection.
func (r ModelRouter) ResolveRequest(req *types.NormalizedRequest) (*types.ResolvedModel, *combos.Pick, error) {
	if req == nil {
		return nil, nil, fmt.Errorf("normalized request is required")
	}
	if combos.IsRequest(req.ModelID) {
		if r.Combos == nil {
			return nil, nil, fmt.Errorf("combo resolver is not configured")
		}
		pick, err := r.Combos.ResolveRequest(req)
		if err != nil {
			return nil, nil, err
		}
		return pick.Resolved, pick, nil
	}
	resolved, err := r.Resolve(req.ModelID)
	if err != nil {
		return nil, nil, err
	}
	req.ModelID = resolved.Model
	return resolved, nil, nil
}

func (r ModelRouter) SupportedEfforts(resolved *types.ResolvedModel) []string {
	if r.Registry == nil || resolved == nil {
		return nil
	}
	for _, model := range r.Registry.ListModels() {
		if model.Provider == resolved.Provider && model.ID == resolved.Model {
			return append([]string(nil), model.ReasoningEfforts...)
		}
	}
	return nil
}
