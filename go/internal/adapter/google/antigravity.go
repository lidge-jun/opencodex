package google

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	DefaultAntigravityUserAgent = "antigravity/cli/1.0.0 (aidev_client; os_type=darwin; arch=arm64)"
	replayTTL                   = time.Hour
	replayMaxEntries            = 10_240
	replayEvictBatch            = 128
)

var foreignThoughtSignature = regexp.MustCompile(`(?i)^(fc|ctc|tsc|call|msg|rs|resp|reasoning|item|ws|toolu|tool|func|function)[-_]`)
var thoughtSignatureChars = regexp.MustCompile(`^[A-Za-z0-9+/_=-]+$`)

func AntigravityRequestUserAgent() string {
	if value := strings.TrimSpace(os.Getenv("GOOGLE_ANTIGRAVITY_USER_AGENT")); value != "" {
		return value
	}
	return DefaultAntigravityUserAgent
}

func IsLikelyRealThoughtSignature(signature string) bool {
	return len(signature) >= 16 && !foreignThoughtSignature.MatchString(signature) && thoughtSignatureChars.MatchString(signature)
}

// AntigravitySessionID mirrors CCA's stable first-user-text session identity.
func AntigravitySessionID(req *types.NormalizedRequest) string {
	if text := firstUserText(req); text != "" {
		digest := sha256.Sum256([]byte(text))
		value := binary.BigEndian.Uint64(digest[:8]) & 0x7fffffffffffffff
		return fmt.Sprintf("-%d", value)
	}
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return fmt.Sprintf("-%d", binary.BigEndian.Uint64(bytes[:])&0x7fffffffffffffff)
	}
	return fmt.Sprintf("-%d", time.Now().UnixNano()&0x7fffffffffffffff)
}

func firstUserText(req *types.NormalizedRequest) string {
	if req == nil {
		return ""
	}
	for _, message := range req.Context.Messages {
		if message.Role != "user" {
			continue
		}
		var text string
		if json.Unmarshal(message.Content, &text) == nil {
			return text
		}
		var parts []map[string]any
		if json.Unmarshal(message.Content, &parts) == nil {
			for _, part := range parts {
				if part["type"] == "text" {
					if text, ok := part["text"].(string); ok {
						return text
					}
				}
			}
		}
	}
	return ""
}

// SanitizeAntigravityClaudeSignatures removes signature shapes rejected by Claude-on-CCA.
func SanitizeAntigravityClaudeSignatures(contents []any) []any {
	for _, rawContent := range contents {
		content, ok := rawContent.(map[string]any)
		if !ok {
			continue
		}
		parts, ok := content["parts"].([]any)
		if !ok {
			continue
		}
		if content["role"] != "model" {
			for _, rawPart := range parts {
				if part, ok := rawPart.(map[string]any); ok {
					delete(part, "thoughtSignature")
					delete(part, "thought_signature")
				}
			}
			continue
		}
		filtered := make([]any, 0, len(parts))
		for _, rawPart := range parts {
			part, ok := rawPart.(map[string]any)
			if ok && part["thought"] == true && !partHasSignature(part) {
				continue
			}
			filtered = append(filtered, rawPart)
		}
		content["parts"] = filtered
	}
	return contents
}

func partHasSignature(part map[string]any) bool {
	for _, key := range []string{"thoughtSignature", "thought_signature"} {
		if signature, ok := part[key].(string); ok && signature != "" {
			return true
		}
	}
	return false
}

type replayEntry struct {
	byCall    map[string]string
	expiresAt time.Time
}

type ReplayStore struct {
	mu      sync.Mutex
	entries map[string]*replayEntry
	now     func() time.Time
}

func NewReplayStore() *ReplayStore {
	return &ReplayStore{entries: make(map[string]*replayEntry), now: time.Now}
}

var defaultReplayStore = NewReplayStore()

func AntigravityUsesReplayCache(model string) bool {
	return !strings.Contains(strings.ToLower(model), "claude")
}

func (s *ReplayStore) Observe(model, sessionID string, parts []any) {
	if s == nil || !AntigravityUsesReplayCache(model) || len(parts) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := replayKey(model, sessionID)
	entry := s.entries[key]
	if entry == nil {
		entry = &replayEntry{byCall: make(map[string]string)}
	}
	changed := false
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok {
			continue
		}
		signature := extractThoughtSignature(part)
		call, _ := part["functionCall"].(map[string]any)
		callKey := functionCallKey(call)
		if signature == "" || callKey == "" {
			continue
		}
		if entry.byCall[callKey] != signature {
			entry.byCall[callKey] = signature
			changed = true
		}
	}
	if !changed && s.entries[key] != nil {
		return
	}
	entry.expiresAt = s.now().Add(replayTTL)
	s.entries[key] = entry
	s.evictLocked()
}

func (s *ReplayStore) Apply(model, sessionID string, contents []any) []any {
	if s == nil || !AntigravityUsesReplayCache(model) {
		return contents
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := replayKey(model, sessionID)
	entry := s.entries[key]
	if entry == nil {
		return contents
	}
	if !entry.expiresAt.After(s.now()) {
		delete(s.entries, key)
		return contents
	}
	for _, rawContent := range contents {
		content, ok := rawContent.(map[string]any)
		if !ok || content["role"] != "model" {
			continue
		}
		for _, rawPart := range anySlice(content["parts"]) {
			part, ok := rawPart.(map[string]any)
			if !ok || part["thoughtSignature"] != nil || part["thought_signature"] != nil {
				continue
			}
			call, _ := part["functionCall"].(map[string]any)
			if signature := entry.byCall[functionCallKey(call)]; signature != "" {
				part["thoughtSignature"] = signature
			}
		}
	}
	return contents
}

func (s *ReplayStore) Clear(model, sessionID string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	delete(s.entries, replayKey(model, sessionID))
	s.mu.Unlock()
}

func (s *ReplayStore) Reset() {
	if s == nil {
		return
	}
	s.mu.Lock()
	clear(s.entries)
	s.mu.Unlock()
}

func (s *ReplayStore) evictLocked() {
	if len(s.entries) <= replayMaxEntries {
		return
	}
	type item struct {
		key string
		exp time.Time
	}
	items := make([]item, 0, len(s.entries))
	for key, entry := range s.entries {
		items = append(items, item{key: key, exp: entry.expiresAt})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].exp.Before(items[j].exp) })
	for index := 0; index < replayEvictBatch && index < len(items); index++ {
		delete(s.entries, items[index].key)
	}
}

func replayKey(model, sessionID string) string { return model + "::session:" + sessionID }

func functionCallKey(call map[string]any) string {
	if call == nil {
		return ""
	}
	name, ok := call["name"].(string)
	if !ok || name == "" {
		return ""
	}
	args := call["args"]
	if args == nil {
		args = map[string]any{}
	}
	encoded, err := json.Marshal(args)
	if err != nil {
		encoded = nil
	}
	return name + "::" + string(encoded)
}

func extractThoughtSignature(part map[string]any) string {
	for _, key := range []string{"thoughtSignature", "thought_signature"} {
		if signature, ok := part[key].(string); ok && len(signature) >= 16 {
			return signature
		}
	}
	extra, _ := part["extra_content"].(map[string]any)
	google, _ := extra["google"].(map[string]any)
	if signature, ok := google["thought_signature"].(string); ok && len(signature) >= 16 {
		return signature
	}
	return ""
}
