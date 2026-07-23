package server

import (
	"fmt"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// ModelRouter resolves public selectors through the canonical registry.
type ModelRouter struct{ Registry types.Registry }

func (r ModelRouter) Resolve(selector string) (*types.ResolvedModel, error) {
	if r.Registry == nil {
		return nil, fmt.Errorf("model registry is not configured")
	}
	return r.Registry.ResolveModel(selector)
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
