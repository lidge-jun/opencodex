package claude

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type Desktop3pConfigMode string

const (
	Desktop3pStatic    Desktop3pConfigMode = "static"
	Desktop3pHybrid    Desktop3pConfigMode = "hybrid"
	Desktop3pDiscovery Desktop3pConfigMode = "discovery"
)

type Desktop3pModelEntry struct {
	Name                string `json:"name"`
	LabelOverride       string `json:"labelOverride"`
	AnthropicFamilyTier string `json:"anthropicFamilyTier"`
	IsFamilyDefault     bool   `json:"isFamilyDefault,omitempty"`
	Supports1M          bool   `json:"supports1m,omitempty"`
}

type Desktop3pRoutedModel struct {
	Provider      string
	ID            string
	ContextWindow int
}

type Desktop3pConfig struct {
	InferenceProvider       string                `json:"inferenceProvider"`
	InferenceCredentialKind string                `json:"inferenceCredentialKind"`
	InferenceGatewayBaseURL string                `json:"inferenceGatewayBaseUrl"`
	InferenceGatewayAPIKey  string                `json:"inferenceGatewayApiKey"`
	ModelDiscoveryEnabled   bool                  `json:"modelDiscoveryEnabled"`
	InferenceModels         []Desktop3pModelEntry `json:"inferenceModels,omitempty"`
}

var desktop3pAliases = struct {
	sync.RWMutex
	values map[string]string
}{values: map[string]string{}}

func ParseDesktop3pModeArgs(flags []string) (Desktop3pConfigMode, error) {
	known := map[string]Desktop3pConfigMode{"--static": Desktop3pStatic, "--hybrid": Desktop3pHybrid, "--discovery-only": Desktop3pDiscovery}
	mode := Desktop3pStatic
	picked := false
	for _, flag := range flags {
		candidate, ok := known[flag]
		if !ok {
			return "", fmt.Errorf("unknown option %q (supported: --static, --hybrid, --discovery-only)", flag)
		}
		if picked && candidate != mode {
			return "", fmt.Errorf("desktop mode options are mutually exclusive")
		}
		mode, picked = candidate, true
	}
	return mode, nil
}

func DeriveDesktop3pCode(route string) string {
	digest := sha256.Sum256([]byte(route))
	n := int(binary.BigEndian.Uint32(digest[:4]) % 33696)
	return string(rune('a'+n/1296)) + base36(n%1296, 2)
}

func base36(value, width int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	result := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		result[i] = alphabet[value%36]
		value /= 36
	}
	return string(result)
}

func Desktop3pAlias(provider, modelID string) string {
	if provider == "anthropic" && strings.HasPrefix(modelID, "claude-") {
		return modelID
	}
	return "claude-opus-4-8-" + DeriveDesktop3pCode(provider+"/"+modelID)
}

func LegacyDesktop3pAlias(provider, modelID string) string {
	return "claude-opus-4-" + DeriveDesktop3pCode(provider+"/"+modelID)
}

func BuildDesktop3pRegistry(nativeSlugs []string, routed []Desktop3pRoutedModel) map[string]string {
	_, registry := collectDesktop3pModels(nativeSlugs, routed)
	installDesktop3pRegistry(registry)
	return cloneStringMap(registry)
}

func GenerateDesktop3pModels(nativeSlugs []string, routed []Desktop3pRoutedModel) []Desktop3pModelEntry {
	models, registry := collectDesktop3pModels(nativeSlugs, routed)
	installDesktop3pRegistry(registry)
	return models
}

func ResolveDesktop3pAlias(alias string) (string, bool) {
	desktop3pAliases.RLock()
	defer desktop3pAliases.RUnlock()
	value, ok := desktop3pAliases.values[alias]
	return value, ok
}

func GenerateDesktop3pConfig(port int, nativeSlugs []string, routed []Desktop3pRoutedModel, apiKey string, mode Desktop3pConfigMode) (Desktop3pConfig, error) {
	if port < 1 || port > 65535 {
		return Desktop3pConfig{}, fmt.Errorf("desktop gateway port must be between 1 and 65535")
	}
	if apiKey == "" {
		apiKey = "ocx"
	}
	if mode == "" {
		mode = Desktop3pStatic
	}
	if mode != Desktop3pStatic && mode != Desktop3pHybrid && mode != Desktop3pDiscovery {
		return Desktop3pConfig{}, fmt.Errorf("unsupported desktop mode %q", mode)
	}
	cfg := Desktop3pConfig{
		InferenceProvider:       "gateway",
		InferenceCredentialKind: "static",
		InferenceGatewayBaseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		InferenceGatewayAPIKey:  apiKey,
		ModelDiscoveryEnabled:   mode != Desktop3pStatic,
	}
	if mode == Desktop3pDiscovery {
		BuildDesktop3pRegistry(nativeSlugs, routed)
	} else {
		cfg.InferenceModels = GenerateDesktop3pModels(nativeSlugs, routed)
	}
	return cfg, nil
}

func DecodeDesktop3pConfig(data []byte) (Desktop3pConfig, error) {
	var cfg Desktop3pConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Desktop3pConfig{}, fmt.Errorf("decode Claude Desktop config: %w", err)
	}
	if cfg.InferenceProvider != "gateway" || cfg.InferenceCredentialKind != "static" || strings.TrimSpace(cfg.InferenceGatewayBaseURL) == "" {
		return Desktop3pConfig{}, fmt.Errorf("invalid Claude Desktop gateway config")
	}
	return cfg, nil
}

func DefaultDesktop3pLibraryPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("Claude Desktop 3P config is supported only on macOS")
	}
	return filepath.Join(home, "Library", "Application Support", "Claude-3p", "configLibrary"), nil
}

func PersistDesktop3pConfig(libraryPath string, port int, nativeSlugs []string, routed []Desktop3pRoutedModel, apiKey string, mode Desktop3pConfigMode) (string, error) {
	if strings.TrimSpace(libraryPath) == "" {
		return "", fmt.Errorf("desktop config library path must not be blank")
	}
	cfg, err := GenerateDesktop3pConfig(port, nativeSlugs, routed, apiKey, mode)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(libraryPath, 0o700); err != nil {
		return "", fmt.Errorf("create desktop config library: %w", err)
	}
	metadataPath := filepath.Join(libraryPath, "_meta.json")
	metadata, entries, err := readDesktop3pMetadata(metadataPath)
	if err != nil {
		return "", err
	}
	id := ""
	for _, entry := range entries {
		if entry["name"] == "opencodex" {
			if existing, ok := entry["id"].(string); ok && existing != "" {
				id = existing
				break
			}
		}
	}
	if id == "" {
		id, err = randomUUID()
		if err != nil {
			return "", err
		}
		entries = append(entries, map[string]any{"id": id, "name": "opencodex"})
	}
	metadata["appliedId"] = id
	metadata["entries"] = entries
	configData, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode desktop config: %w", err)
	}
	metadataData, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode desktop metadata: %w", err)
	}
	configPath := filepath.Join(libraryPath, id+".json")
	if err := atomicWriteFile(configPath, append(configData, '\n'), 0o600); err != nil {
		return "", fmt.Errorf("write desktop config: %w", err)
	}
	if err := atomicWriteFile(metadataPath, append(metadataData, '\n'), 0o600); err != nil {
		return "", fmt.Errorf("write desktop metadata: %w", err)
	}
	return configPath, nil
}

func readDesktop3pMetadata(path string) (map[string]any, []map[string]any, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]any{}, []map[string]any{}, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read desktop metadata: %w", err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, nil, fmt.Errorf("decode desktop metadata: %w", err)
	}
	rawEntries, ok := metadata["entries"].([]any)
	if !ok {
		return nil, nil, fmt.Errorf("Claude Desktop _meta.json has no entries array")
	}
	entries := make([]map[string]any, 0, len(rawEntries))
	for _, raw := range rawEntries {
		entry, ok := raw.(map[string]any)
		if !ok {
			return nil, nil, fmt.Errorf("Claude Desktop _meta.json contains an invalid entry")
		}
		entries = append(entries, entry)
	}
	return metadata, entries, nil
}

func collectDesktop3pModels(nativeSlugs []string, routed []Desktop3pRoutedModel) ([]Desktop3pModelEntry, map[string]string) {
	candidates := make([]Desktop3pRoutedModel, 0, len(nativeSlugs)+len(routed))
	for _, id := range nativeSlugs {
		candidates = append(candidates, Desktop3pRoutedModel{Provider: nativeProvider, ID: id})
	}
	candidates = append(candidates, routed...)
	models := make([]Desktop3pModelEntry, 0, len(candidates))
	registry := make(map[string]string)
	for _, candidate := range candidates {
		if candidate.Provider == "" || candidate.ID == "" {
			continue
		}
		route := candidate.Provider + "/" + candidate.ID
		alias := Desktop3pAlias(candidate.Provider, candidate.ID)
		entry := Desktop3pModelEntry{Name: alias, LabelOverride: displayDesktop3pModelID(candidate.ID) + " (" + candidate.Provider + ")", AnthropicFamilyTier: "opus", Supports1M: candidate.ContextWindow >= OneMillion}
		if alias == candidate.ID {
			models = append(models, entry)
			continue
		}
		if _, collision := registry[alias]; collision {
			continue
		}
		registry[alias] = route
		legacy := LegacyDesktop3pAlias(candidate.Provider, candidate.ID)
		if _, exists := registry[legacy]; !exists {
			registry[legacy] = route
		}
		models = append(models, entry)
	}
	if len(models) > 0 {
		models[0].IsFamilyDefault = true
	}
	return models, registry
}

func displayDesktop3pModelID(id string) string {
	parts := strings.FieldsFunc(id, func(r rune) bool { return r == '-' || r == '_' })
	for i, part := range parts {
		lower := strings.ToLower(part)
		if lower == "gpt" || lower == "glm" || lower == "ai" {
			parts[i] = strings.ToUpper(lower)
		} else if part != "" {
			parts[i] = strings.ToUpper(part[:1]) + part[1:]
		}
	}
	return strings.Join(parts, " ")
}

func installDesktop3pRegistry(registry map[string]string) {
	desktop3pAliases.Lock()
	desktop3pAliases.values = cloneStringMap(registry)
	desktop3pAliases.Unlock()
}

func cloneStringMap(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func randomUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate desktop config id: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(value[:])
	return hexValue[:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:], nil
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".ocx-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	committed = true
	return nil
}
