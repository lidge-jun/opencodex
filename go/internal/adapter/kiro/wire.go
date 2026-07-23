package kiro

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/user"
	"regexp"
	"runtime"
	"strings"
	"sync"
)

var (
	fingerprintOnce       sync.Once
	fingerprintValue      string
	conversationIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)
	effortSuffix          = regexp.MustCompile(`-(low|medium|high|xhigh|max)$`)
	dateSuffix            = regexp.MustCompile(`-\d{8}$`)
	digitDash             = regexp.MustCompile(`(\d+)-(\d+)`)
	legacyClaude          = regexp.MustCompile(`^claude-([\d.]+)-(sonnet|opus|haiku)$`)
)

func Fingerprint() string {
	fingerprintOnce.Do(func() {
		host, hostErr := os.Hostname()
		current, userErr := user.Current()
		seed := "default-kiro"
		if hostErr == nil && userErr == nil {
			seed = host + "-" + current.Username + "-kiro"
		}
		sum := sha256.Sum256([]byte(seed))
		fingerprintValue = hex.EncodeToString(sum[:])
	})
	return fingerprintValue
}

func OSTag() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos#24.0.0"
	case "windows":
		return "win32#10.0.26100"
	default:
		return "linux#6.8.0"
	}
}

func MapModelID(id string) string {
	model := strings.ToLower(strings.TrimSpace(id))
	model = strings.TrimPrefix(model, "kiro/")
	model = strings.TrimPrefix(model, "kiro-")
	if model == "auto" {
		return model
	}
	model = dateSuffix.ReplaceAllString(model, "")
	model = effortSuffix.ReplaceAllString(model, "")
	model = digitDash.ReplaceAllString(model, "$1.$2")
	if match := legacyClaude.FindStringSubmatch(model); match != nil {
		model = "claude-" + match[2] + "-" + match[1]
	}
	return model
}

func NormalizeToolID(id string) string {
	var b strings.Builder
	for _, r := range id {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
		if b.Len() >= 64 {
			break
		}
	}
	return b.String()
}

func KiroToolName(wireName string, used map[string]struct{}) string {
	cleaned := NormalizeToolID(wireName)
	if cleaned == wireName && cleaned != "" && len(cleaned) <= 64 {
		if _, exists := used[cleaned]; !exists {
			used[cleaned] = struct{}{}
			return cleaned
		}
	}
	base := cleaned
	if len(base) > 55 {
		base = base[:55]
	}
	if base == "" {
		base = "tool"
	}
	for salt := 0; ; salt++ {
		hashInput := wireName
		if salt > 0 {
			hashInput = fmt.Sprintf("%s#%d", wireName, salt)
		}
		sum := sha256.Sum256([]byte(hashInput))
		candidate := base + "_" + hex.EncodeToString(sum[:4])
		if _, exists := used[candidate]; !exists {
			used[candidate] = struct{}{}
			return candidate
		}
	}
}

type ToolNameRegistry struct {
	used       map[string]struct{}
	wireToKiro map[string]string
	kiroToWire map[string]string
}

func NewToolNameRegistry() *ToolNameRegistry {
	return &ToolNameRegistry{used: map[string]struct{}{CompletionToolName: {}}, wireToKiro: map[string]string{}, kiroToWire: map[string]string{}}
}

func (r *ToolNameRegistry) Alias(wireName string) (string, error) {
	if wireName == CompletionToolName {
		return "", fmt.Errorf("Kiro reserves tool name %q", CompletionToolName)
	}
	if existing := r.wireToKiro[wireName]; existing != "" {
		return existing, nil
	}
	alias := KiroToolName(wireName, r.used)
	r.wireToKiro[wireName] = alias
	if alias != wireName {
		r.kiroToWire[alias] = wireName
	}
	return alias, nil
}

func (r *ToolNameRegistry) Restore(name string) string {
	if restored := r.kiroToWire[name]; restored != "" {
		return restored
	}
	return name
}

func (r *ToolNameRegistry) NameMap() map[string]string {
	out := make(map[string]string, len(r.kiroToWire))
	for k, v := range r.kiroToWire {
		out[k] = v
	}
	return out
}

func InvocationID() string      { return randomUUID() }
func FallbackToolUseID() string { return "toolu_" + strings.ReplaceAll(randomUUID(), "-", "")[:8] }

func randomUUID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(fmt.Sprintf("kiro random id: %v", err))
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

func IsValidConversationID(value string) bool { return conversationIDPattern.MatchString(value) }
