package combos

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	DecisionHop     = "hop"
	DecisionStop    = "stop"
	defaultCooldown = time.Minute
	maxCooldown     = 10 * time.Minute
)

// ParseRetryAfter accepts delta-seconds and HTTP-date forms, capped at ten minutes.
func ParseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(text, 64); err == nil && seconds > 0 {
		delay := time.Duration(seconds * float64(time.Second))
		if delay < time.Millisecond {
			delay = time.Millisecond
		}
		if delay > maxCooldown {
			delay = maxCooldown
		}
		return delay, true
	}
	when, err := time.Parse(time.RFC1123, text)
	if err != nil {
		when, err = time.Parse(time.RFC1123Z, text)
	}
	if err != nil || !when.After(now) {
		return 0, false
	}
	delay := when.Sub(now)
	if delay > maxCooldown {
		delay = maxCooldown
	}
	return delay, true
}

// FailureDecision decides whether an upstream failure is safe to retry on a
// different target. Request-shape and caller-cancellation failures stop.
func FailureDecision(status int, code, message string) string {
	normalized := strings.ToLower(code + " " + message)
	if status == 499 || strings.Contains(normalized, "origin_rejected") || strings.Contains(normalized, "context_length_exceeded") || strings.Contains(normalized, "invalid_request") {
		return DecisionStop
	}
	if status == 401 || status == 403 || status == 404 || status == 408 || status == 429 || status >= 500 {
		return DecisionHop
	}
	for _, retryable := range []string{"permission_denied", "subscription_required", "invalid_api_key", "insufficient_quota", "rate_limit_exceeded", "server_is_overloaded", "upstream_server_error"} {
		if strings.Contains(normalized, retryable) {
			return DecisionHop
		}
	}
	return DecisionStop
}

func cooldownKey(comboID string, target Target) string { return comboID + "\x00" + TargetKey(target) }

func (r *Resolver) inCooldownLocked(comboID string, target Target, now time.Time) bool {
	key := cooldownKey(comboID, target)
	until, ok := r.cooldowns[key]
	if !ok {
		return false
	}
	if !until.After(now) {
		delete(r.cooldowns, key)
		return false
	}
	return true
}

func (r *Resolver) Cooldown(comboID string, target Target, retryAfter string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delay, ok := ParseRetryAfter(retryAfter, r.now())
	if !ok {
		delay = defaultCooldown
	}
	r.cooldowns[cooldownKey(comboID, target)] = r.now().Add(delay)
}

func (r *Resolver) InCooldown(comboID string, target Target) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.inCooldownLocked(comboID, target, r.now())
}

// Next returns the next target after a retryable failure and rewrites req.
func (r *Resolver) Next(req *types.NormalizedRequest, pick *Pick, status int, code, message, retryAfter string) (*Pick, error) {
	if pick == nil {
		return nil, fmt.Errorf("combo pick is required")
	}
	if FailureDecision(status, code, message) == DecisionStop {
		return nil, fmt.Errorf("combo failure is not retryable: %s", message)
	}
	if len(pick.Attempted)-1 >= pick.MaxHops {
		return nil, &NoAvailableTargetsError{ID: pick.ComboID}
	}
	r.mu.Lock()
	r.noteFailureLocked(pick)
	delay, ok := ParseRetryAfter(retryAfter, r.now())
	if !ok {
		delay = defaultCooldown
	}
	r.cooldowns[cooldownKey(pick.ComboID, pick.Target)] = r.now().Add(delay)
	excluded := make(map[string]bool, len(pick.Attempted))
	for _, key := range pick.Attempted {
		excluded[key] = true
	}
	next, err := r.pickLocked(pick.ComboID, excluded, r.now())
	combo := r.combos[pick.ComboID]
	r.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if err := RewriteRequest(req, next, combo.DefaultEffort); err != nil {
		return nil, err
	}
	return next, nil
}
