// Package combos resolves virtual combo models to concrete provider models.
package combos

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const (
	Namespace          = "combo"
	StrategyFailover   = "failover"
	StrategyRoundRobin = "round-robin"
)

var (
	comboIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	aliasPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$`)
	nativeAliasPattern = regexp.MustCompile(`^(?:gpt-|o1-|o3-|o4-|codex-)`)
	validEfforts       = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true, "ultra": true}
)

// Target is one concrete provider/model member of a combo.
type Target struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Weight   int    `json:"weight,omitempty"`
}

// Combo is the persisted definition of a virtual model. ID is normally supplied
// by the containing map key and is populated in normalized resolver copies.
type Combo struct {
	ID            string   `json:"id,omitempty"`
	Alias         string   `json:"alias,omitempty"`
	Strategy      string   `json:"strategy,omitempty"`
	StickyLimit   int      `json:"stickyLimit,omitempty"`
	DefaultEffort string   `json:"defaultEffort,omitempty"`
	MaxHops       int      `json:"maxHops,omitempty"`
	Targets       []Target `json:"targets"`
}

// Provider describes the provider facts needed for combo validation.
type Provider struct {
	Disabled bool
}

func ModelID(id string) string { return Namespace + "/" + id }

func ParseModelID(modelID string) (string, bool) {
	if !strings.HasPrefix(modelID, Namespace+"/") {
		return "", false
	}
	id := strings.TrimPrefix(modelID, Namespace+"/")
	return id, id != "" && !strings.Contains(id, "/")
}

func IsRequest(modelID string) bool {
	_, ok := ParseModelID(strings.TrimSpace(modelID))
	return ok
}

func TargetKey(target Target) string { return target.Provider + "/" + target.Model }

// ValidateBasic checks definition-local invariants without consulting providers.
func ValidateBasic(id string, combo Combo) error {
	if !comboIDPattern.MatchString(id) {
		return fmt.Errorf("combo %q: id must start with a letter or number and use letters, numbers, dot, underscore, or hyphen (max 64)", id)
	}
	strategy := combo.Strategy
	if strategy == "" {
		strategy = StrategyFailover
	}
	if strategy != StrategyFailover && strategy != StrategyRoundRobin {
		return fmt.Errorf("combo %q: strategy must be %q or %q", id, StrategyFailover, StrategyRoundRobin)
	}
	if combo.StickyLimit < 0 || combo.StickyLimit > 100 {
		return fmt.Errorf("combo %q: stickyLimit must be an integer from 1 to 100", id)
	}
	if combo.DefaultEffort != "" && !validEfforts[combo.DefaultEffort] {
		return fmt.Errorf("combo %q: defaultEffort must be one of: low, medium, high, xhigh, max, ultra", id)
	}
	alias := strings.TrimSpace(combo.Alias)
	if alias != "" {
		if !aliasPattern.MatchString(alias) {
			return fmt.Errorf("combo %q: alias must use letters, numbers, dot, underscore, or hyphen, with at most one slash segment", id)
		}
		if alias == Namespace || strings.HasPrefix(alias, Namespace+"/") {
			return fmt.Errorf("combo %q: alias must not use reserved %q namespace", id, Namespace+"/")
		}
		if !strings.Contains(alias, "/") && nativeAliasPattern.MatchString(alias) {
			return fmt.Errorf("combo %q: bare OpenAI-family aliases are not allowed", id)
		}
	}
	if len(combo.Targets) == 0 {
		return fmt.Errorf("combo %q: targets must be a non-empty array", id)
	}
	if combo.MaxHops < 0 || combo.MaxHops > len(combo.Targets)-1 {
		return fmt.Errorf("combo %q: maxHops must be between 0 and %d", id, len(combo.Targets)-1)
	}
	seen := make(map[string]struct{}, len(combo.Targets))
	for index, target := range combo.Targets {
		provider := strings.TrimSpace(target.Provider)
		model := strings.TrimSpace(target.Model)
		if provider == "" {
			return fmt.Errorf("combo %q: targets[%d].provider is required", id, index)
		}
		if model == "" {
			return fmt.Errorf("combo %q: targets[%d].model is required", id, index)
		}
		if target.Weight < 0 || target.Weight > 10_000 {
			return fmt.Errorf("combo %q: targets[%d].weight must be an integer from 1 to 10000", id, index)
		}
		key := provider + "/" + model
		if _, ok := seen[key]; ok {
			return fmt.Errorf("combo %q: duplicate target %q", id, key)
		}
		seen[key] = struct{}{}
	}
	return nil
}

func validateAll(definitions map[string]Combo, providers map[string]Provider) error {
	ids := make([]string, 0, len(definitions))
	for id := range definitions {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	aliases := make(map[string]string)
	for _, id := range ids {
		combo := definitions[id]
		if err := ValidateBasic(id, combo); err != nil {
			return err
		}
		if _, collision := providers[Namespace]; collision {
			return fmt.Errorf("combo %q: provider name %q collides with reserved %q namespace", id, Namespace, Namespace+"/")
		}
		if _, collision := providers[id]; collision {
			return fmt.Errorf("combo id %q collides with configured provider name", id)
		}
		alias := strings.TrimSpace(combo.Alias)
		if owner, duplicate := aliases[alias]; alias != "" && duplicate {
			return fmt.Errorf("combo %q: alias %q is already used by combo %q", id, alias, owner)
		}
		if alias != "" {
			aliases[alias] = id
		}
		usable := 0
		for _, target := range combo.Targets {
			provider, ok := providers[strings.TrimSpace(target.Provider)]
			if !ok {
				return fmt.Errorf("combo %q: target provider %q is not configured", id, target.Provider)
			}
			if !provider.Disabled {
				usable++
			}
		}
		if usable == 0 {
			return fmt.Errorf("combo %q: targets must include at least one enabled provider", id)
		}
	}
	return nil
}

func normalize(id string, combo Combo) Combo {
	combo.ID = id
	combo.Alias = strings.TrimSpace(combo.Alias)
	if combo.Strategy == "" {
		combo.Strategy = StrategyFailover
	}
	if combo.StickyLimit == 0 {
		combo.StickyLimit = 1
	}
	if combo.MaxHops == 0 && len(combo.Targets) > 1 {
		combo.MaxHops = len(combo.Targets) - 1
	}
	combo.Targets = append([]Target(nil), combo.Targets...)
	for i := range combo.Targets {
		combo.Targets[i].Provider = strings.TrimSpace(combo.Targets[i].Provider)
		combo.Targets[i].Model = strings.TrimSpace(combo.Targets[i].Model)
		if combo.Targets[i].Weight == 0 {
			combo.Targets[i].Weight = 1
		}
	}
	return combo
}
