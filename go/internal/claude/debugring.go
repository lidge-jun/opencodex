package claude

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"sync"
	"time"
)

const DefaultDebugRingLimit = 20

type ClaudeInboundDebugEntry struct {
	At                 int64    `json:"at"`
	Endpoint           string   `json:"endpoint"`
	Model              string   `json:"model"`
	ResolvedModel      string   `json:"resolvedModel,omitempty"`
	Stream             *bool    `json:"stream,omitempty"`
	MaxTokens          int      `json:"maxTokens,omitempty"`
	ThinkingType       string   `json:"thinkingType,omitempty"`
	ThinkingBudget     int      `json:"thinkingBudgetTokens,omitempty"`
	OutputConfigEffort string   `json:"outputConfigEffort,omitempty"`
	MetadataKeys       []string `json:"metadataKeys,omitempty"`
	HasMetadataUserID  bool     `json:"hasMetadataUserId"`
	HasSystem          bool     `json:"hasSystem"`
	AnthropicBeta      string   `json:"anthropicBeta,omitempty"`
	UserIDTag          string   `json:"userIdTag,omitempty"`
	SystemTag          string   `json:"systemTag,omitempty"`
}

type DebugRing struct {
	mu      sync.RWMutex
	enabled bool
	limit   int
	salt    []byte
	entries []ClaudeInboundDebugEntry
}

func NewDebugRing(limit int, enabled bool) *DebugRing {
	if limit <= 0 {
		limit = DefaultDebugRingLimit
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		panic("claude debug ring: secure random unavailable")
	}
	return &DebugRing{enabled: enabled, limit: limit, salt: salt, entries: make([]ClaudeInboundDebugEntry, 0, limit)}
}

func (r *DebugRing) SetEnabled(enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !enabled {
		clear(r.entries)
		r.entries = r.entries[:0]
	}
	r.enabled = enabled
}

func (r *DebugRing) Enabled() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.enabled
}

func (r *DebugRing) Capture(endpoint string, body any, resolvedModel, anthropicBeta string) {
	if endpoint != "messages" && endpoint != "count_tokens" {
		return
	}
	request, ok := body.(map[string]any)
	if !ok {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.enabled {
		return
	}
	entry := ClaudeInboundDebugEntry{At: time.Now().UnixMilli(), Endpoint: endpoint, Model: "unknown", ResolvedModel: resolvedModel, AnthropicBeta: anthropicBeta}
	if model, ok := request["model"].(string); ok {
		entry.Model = model
	}
	if stream, ok := request["stream"].(bool); ok {
		entry.Stream = &stream
	}
	entry.MaxTokens = debugInteger(request["max_tokens"])
	if thinking, ok := request["thinking"].(map[string]any); ok {
		entry.ThinkingType, _ = thinking["type"].(string)
		entry.ThinkingBudget = debugInteger(thinking["budget_tokens"])
	}
	if output, ok := request["output_config"].(map[string]any); ok {
		entry.OutputConfigEffort, _ = output["effort"].(string)
	}
	if metadata, ok := request["metadata"].(map[string]any); ok {
		entry.MetadataKeys = make([]string, 0, len(metadata))
		for key := range metadata {
			entry.MetadataKeys = append(entry.MetadataKeys, key)
		}
		sort.Strings(entry.MetadataKeys)
		if userID, ok := metadata["user_id"].(string); ok {
			entry.HasMetadataUserID = true
			entry.UserIDTag = r.tag(userID)
		}
	}
	if system := systemText(request["system"]); system != "" {
		entry.HasSystem = true
		entry.SystemTag = r.tag(system)
	}
	if len(r.entries) == r.limit {
		copy(r.entries, r.entries[1:])
		r.entries[len(r.entries)-1] = entry
	} else {
		r.entries = append(r.entries, entry)
	}
}

func (r *DebugRing) Entries() []ClaudeInboundDebugEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]ClaudeInboundDebugEntry, len(r.entries))
	for i := range r.entries {
		entry := r.entries[len(r.entries)-1-i]
		entry.MetadataKeys = append([]string(nil), entry.MetadataKeys...)
		result[i] = entry
	}
	return result
}

func (r *DebugRing) Clear() {
	r.mu.Lock()
	clear(r.entries)
	r.entries = r.entries[:0]
	r.mu.Unlock()
}

func (r *DebugRing) tag(value string) string {
	digest := hmac.New(sha256.New, r.salt)
	_, _ = digest.Write([]byte(value))
	return hex.EncodeToString(digest.Sum(nil))[:8]
}

func debugInteger(value any) int {
	switch number := value.(type) {
	case int:
		return number
	case int64:
		return int(number)
	case float64:
		if number >= 0 && number == float64(int(number)) {
			return int(number)
		}
	}
	return 0
}
