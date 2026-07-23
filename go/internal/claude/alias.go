package claude

import "strings"

const (
	AliasPrefix    = "claude-ocx-"
	nativeProvider = "native"
)

func AliasForRoute(provider, model string) (string, bool) {
	if provider == "" || model == "" || provider == nativeProvider || strings.Contains(provider, "--") || strings.ContainsAny(provider, "/") || strings.Contains(model, "/") {
		return "", false
	}
	return AliasPrefix + provider + "--" + model, true
}

func AliasForNative(model string) (string, bool) {
	if model == "" || strings.Contains(model, "/") || strings.Contains(model, "--") {
		return "", false
	}
	return AliasPrefix + nativeProvider + "--" + model, true
}

func ResolveAlias(id string) (string, bool) {
	if !strings.HasPrefix(id, AliasPrefix) {
		return "", false
	}
	rest := strings.TrimPrefix(id, AliasPrefix)
	sep := strings.Index(rest, "--")
	if sep <= 0 || sep+2 == len(rest) {
		return "", false
	}
	provider, model := rest[:sep], rest[sep+2:]
	if provider == nativeProvider {
		return model, true
	}
	return provider + "/" + model, true
}

func ClaudeCodeAlias(provider, model string) string {
	if provider == "anthropic" && strings.HasPrefix(model, "claude-") {
		return model
	}
	if alias, ok := AliasForRoute(provider, model); ok {
		return alias
	}
	return model
}

func ClaudeCodeNativeAlias(model string) string {
	if alias, ok := AliasForNative(model); ok {
		return alias
	}
	return model
}
