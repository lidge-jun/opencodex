package registry

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultKeyCooldown = time.Minute
	MaxKeyCooldown     = 10 * time.Minute
)

type APIKey struct {
	ID      string    `json:"id"`
	Label   string    `json:"label,omitempty"`
	Value   string    `json:"-"`
	AddedAt time.Time `json:"addedAt,omitempty"`
}

type APIKeyPool struct {
	mu       sync.Mutex
	keys     []APIKey
	active   int
	cooldown map[string]time.Time
}

func NewAPIKeyPool(values ...string) *APIKeyPool {
	pool := &APIKeyPool{active: -1, cooldown: make(map[string]time.Time)}
	for _, value := range values {
		_, _ = pool.Add(value, "")
	}
	if len(pool.keys) > 0 {
		pool.active = 0
	}
	return pool
}

func keyID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:4])
}

func (p *APIKeyPool) Add(value, label string) (string, error) {
	value, label = strings.TrimSpace(value), strings.TrimSpace(label)
	if value == "" {
		return "", errors.New("API key is required")
	}
	if strings.ContainsAny(value, "\r\n") {
		return "", errors.New("API key must not contain line breaks")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	id := keyID(value)
	for i := range p.keys {
		if p.keys[i].ID == id {
			if label != "" {
				p.keys[i].Label = label
			}
			p.active = i
			return id, nil
		}
	}
	p.keys = append(p.keys, APIKey{ID: id, Label: label, Value: value, AddedAt: time.Now()})
	p.active = len(p.keys) - 1
	return id, nil
}

func (p *APIKeyPool) SetActive(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.keys {
		if p.keys[i].ID == id {
			p.active = i
			return true
		}
	}
	return false
}

func (p *APIKeyPool) Remove(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range p.keys {
		if p.keys[i].ID != id {
			continue
		}
		p.keys = append(p.keys[:i], p.keys[i+1:]...)
		delete(p.cooldown, id)
		if len(p.keys) == 0 {
			p.active = -1
		} else if p.active >= len(p.keys) || p.active == i {
			p.active = 0
		} else if p.active > i {
			p.active--
		}
		return true
	}
	return false
}

func (p *APIKeyPool) Active() (APIKey, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active < 0 || p.active >= len(p.keys) {
		return APIKey{}, false
	}
	return p.keys[p.active], true
}

func (p *APIKeyPool) Keys() []APIKey {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]APIKey(nil), p.keys...)
}

// RotateOn429 cools the key that actually failed and chooses the next healthy slot.
func (p *APIKeyPool) RotateOn429(attemptedID, retryAfter string, now time.Time) (APIKey, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.keys) < 2 {
		return APIKey{}, false
	}
	failed := p.active
	if attemptedID != "" {
		failed = -1
		for i := range p.keys {
			if p.keys[i].ID == attemptedID {
				failed = i
				break
			}
		}
	}
	if failed >= 0 {
		p.cooldown[p.keys[failed].ID] = now.Add(parseRetryAfter(retryAfter, now))
	}
	if attemptedID != "" && p.active >= 0 && p.keys[p.active].ID != attemptedID && !p.coolingDown(p.keys[p.active].ID, now) {
		return p.keys[p.active], true
	}
	for step := 1; step < len(p.keys); step++ {
		index := (failed + step + len(p.keys)) % len(p.keys)
		if !p.coolingDown(p.keys[index].ID, now) {
			p.active = index
			return p.keys[index], true
		}
	}
	return APIKey{}, false
}

func (p *APIKeyPool) coolingDown(id string, now time.Time) bool {
	until, ok := p.cooldown[id]
	if !ok {
		return false
	}
	if !until.After(now) {
		delete(p.cooldown, id)
		return false
	}
	return true
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds > 0 {
		return clampKeyCooldown(time.Duration(seconds * float64(time.Second)))
	}
	if when, err := http.ParseTime(value); err == nil && when.After(now) {
		return clampKeyCooldown(when.Sub(now))
	}
	return DefaultKeyCooldown
}

func clampKeyCooldown(value time.Duration) time.Duration {
	if value < time.Millisecond {
		return time.Millisecond
	}
	if value > MaxKeyCooldown {
		return MaxKeyCooldown
	}
	return value
}
