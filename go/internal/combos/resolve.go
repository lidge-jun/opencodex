package combos

import (
	"fmt"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type selectionState struct {
	activeKey     string
	successes     int
	currentWeight map[string]int
}

// Pick records one selected target and the targets already attempted.
type Pick struct {
	ComboID     string
	Target      Target
	TargetIndex int
	Attempted   []string
	MaxHops     int
	Resolved    *types.ResolvedModel
}

type UnknownComboError struct{ ID string }

func (e *UnknownComboError) Error() string { return fmt.Sprintf("unknown combo: %s", e.ID) }

type NoAvailableTargetsError struct{ ID string }

func (e *NoAvailableTargetsError) Error() string {
	return fmt.Sprintf("no available targets for combo: %s", e.ID)
}
func (e *NoAvailableTargetsError) Code() string { return "combo_unavailable" }

func (r *Resolver) pickLocked(comboID string, excluded map[string]bool, now time.Time) (*Pick, error) {
	combo, ok := r.combos[comboID]
	if !ok {
		return nil, &UnknownComboError{ID: comboID}
	}
	eligible := func(target Target) bool {
		key := TargetKey(target)
		provider := r.providers[target.Provider]
		return !provider.Disabled && !excluded[key] && !r.inCooldownLocked(comboID, target, now)
	}
	index := -1
	state := r.states[comboID]
	if state == nil {
		state = &selectionState{currentWeight: make(map[string]int)}
		r.states[comboID] = state
	}
	if combo.Strategy == StrategyRoundRobin {
		if state.activeKey != "" {
			for i, target := range combo.Targets {
				if TargetKey(target) == state.activeKey && eligible(target) {
					index = i
					break
				}
			}
			if index < 0 {
				state.activeKey, state.successes = "", 0
			}
		}
		if index < 0 {
			bestScore, total := 0, 0
			bestSet := false
			for i, target := range combo.Targets {
				if !eligible(target) {
					continue
				}
				key := TargetKey(target)
				score := state.currentWeight[key] + target.Weight
				state.currentWeight[key] = score
				total += target.Weight
				if !bestSet || score > bestScore {
					index, bestScore, bestSet = i, score, true
				}
			}
			if index >= 0 {
				key := TargetKey(combo.Targets[index])
				state.currentWeight[key] -= total
				state.activeKey, state.successes = key, 0
			}
		}
	} else {
		for i, target := range combo.Targets {
			if eligible(target) {
				index = i
				break
			}
		}
	}
	if index < 0 {
		return nil, &NoAvailableTargetsError{ID: comboID}
	}
	target := combo.Targets[index]
	attempted := make([]string, 0, len(excluded)+1)
	for _, prior := range combo.Targets {
		if excluded[TargetKey(prior)] {
			attempted = append(attempted, TargetKey(prior))
		}
	}
	attempted = append(attempted, TargetKey(target))
	return &Pick{ComboID: comboID, Target: target, TargetIndex: index, Attempted: attempted, MaxHops: combo.MaxHops, Resolved: &types.ResolvedModel{Selector: ModelID(comboID), Provider: target.Provider, Model: target.Model, Effort: combo.DefaultEffort}}, nil
}

// PickTarget selects one eligible target using the combo strategy.
func (r *Resolver) PickTarget(modelID string, exclude ...string) (*Pick, error) {
	comboID, ok := r.comboID(modelID)
	if !ok {
		return nil, fmt.Errorf("not a combo model: %s", modelID)
	}
	excluded := make(map[string]bool, len(exclude))
	for _, key := range exclude {
		excluded[key] = true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pickLocked(comboID, excluded, r.now())
}

// NoteSuccess advances a sticky round-robin batch after enough successes.
func (r *Resolver) NoteSuccess(pick *Pick) {
	if pick == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	combo, ok := r.combos[pick.ComboID]
	state := r.states[pick.ComboID]
	if !ok || combo.Strategy != StrategyRoundRobin || state == nil || state.activeKey != TargetKey(pick.Target) {
		return
	}
	state.successes++
	if state.successes >= combo.StickyLimit {
		state.activeKey, state.successes = "", 0
	}
}

func (r *Resolver) noteFailureLocked(pick *Pick) {
	state := r.states[pick.ComboID]
	if state != nil && state.activeKey == TargetKey(pick.Target) {
		state.activeKey, state.successes = "", 0
	}
}
