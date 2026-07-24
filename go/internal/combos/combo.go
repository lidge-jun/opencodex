package combos

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// Resolver owns immutable normalized combo definitions and synchronized runtime state.
type Resolver struct {
	mu        sync.Mutex
	combos    map[string]Combo
	aliases   map[string]string
	providers map[string]Provider
	states    map[string]*selectionState
	cooldowns map[string]time.Time
	now       func() time.Time
}

func New(definitions map[string]Combo, providers map[string]Provider) (*Resolver, error) {
	if err := validateAll(definitions, providers); err != nil {
		return nil, err
	}
	r := &Resolver{combos: make(map[string]Combo, len(definitions)), aliases: make(map[string]string), providers: make(map[string]Provider, len(providers)), states: make(map[string]*selectionState), cooldowns: make(map[string]time.Time), now: time.Now}
	for name, provider := range providers {
		r.providers[name] = provider
	}
	for id, definition := range definitions {
		combo := normalize(id, definition)
		r.combos[id] = combo
		if combo.Alias != "" {
			r.aliases[combo.Alias] = id
		}
	}
	return r, nil
}

func (r *Resolver) comboID(modelID string) (string, bool) {
	modelID = strings.TrimSpace(modelID)
	if id, ok := ParseModelID(modelID); ok {
		return id, true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := r.aliases[modelID]
	return id, ok
}

// Resolve satisfies types.ComboResolver and returns the normalized definition.
func (r *Resolver) Resolve(comboID string) (*types.ResolvedCombo, error) {
	if id, ok := ParseModelID(comboID); ok {
		comboID = id
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	combo, ok := r.combos[comboID]
	if !ok {
		return nil, &UnknownComboError{ID: comboID}
	}
	targets := make([]types.ResolvedModel, len(combo.Targets))
	for i, target := range combo.Targets {
		targets[i] = types.ResolvedModel{Selector: ModelID(comboID), Provider: target.Provider, Model: target.Model, Effort: combo.DefaultEffort}
	}
	return &types.ResolvedCombo{ID: comboID, Strategy: combo.Strategy, Targets: targets, DefaultEffort: combo.DefaultEffort, Metadata: map[string]string{"alias": combo.Alias, "maxHops": fmt.Sprint(combo.MaxHops)}}, nil
}

func (r *Resolver) IDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.combos))
	for id := range r.combos {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

var _ types.ComboResolver = (*Resolver)(nil)
