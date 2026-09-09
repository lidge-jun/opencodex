package ocxcli

// Claude Code surface model aliases — the Go mirror of src/claude/alias.ts and
// the desktop3pAlias fallback in src/claude/desktop-3p.ts (issue #56 slice).
//
// Aliases must be deterministic, reversible, and STABLE across releases:
// Claude Code persists picker selections in settings.json `model`, so the
// decode path must keep working forever. claude-ocx- (v1) is a literal prefix;
// claude-ocx2- (v2) escape-encodes "/" as ~s and "~" as ~t so routed model ids
// with those characters cannot collide with v1 literals.

import (
	"crypto/sha256"
	"encoding/binary"
	"strconv"
	"strings"
)

const (
	claudeAliasPrefixV1  = "claude-ocx-"
	claudeAliasPrefixV2  = "claude-ocx2-"
	claudeAliasSlashEnc  = "~s"
	claudeAliasTildeEnc  = "~t"
	claudeNativeProvider = "native"
	// desktop3pAliasPrefix mirrors `claude-opus-4-8-${code}` (desktop-3p.ts).
	desktop3pAliasPrefix = "claude-opus-4-8-"
)

func claudeModelNeedsEscapeEncoding(modelID string) bool {
	return strings.Contains(modelID, "/") || strings.Contains(modelID, "~")
}

// claudeEncodeModelID escapes literal tildes first so slash encoding cannot
// create ambiguity.
func claudeEncodeModelID(modelID string) string {
	encoded := strings.ReplaceAll(modelID, "~", claudeAliasTildeEnc)
	return strings.ReplaceAll(encoded, "/", claudeAliasSlashEnc)
}

func claudeDecodeEscapedModelID(encoded string) string {
	var out strings.Builder
	for i := 0; i < len(encoded); i++ {
		if encoded[i] == '~' && i+1 < len(encoded) {
			switch encoded[i+1] {
			case 's':
				out.WriteByte('/')
				i++
				continue
			case 't':
				out.WriteByte('~')
				i++
				continue
			}
		}
		out.WriteByte(encoded[i])
	}
	return out.String()
}

// claudeSplitAlias splits "<provider>--<model>" after the FIRST "--" only.
func claudeSplitAlias(id, prefix string) (provider, model string, ok bool) {
	rest := id[len(prefix):]
	sep := strings.Index(rest, "--")
	if sep <= 0 {
		return "", "", false
	}
	provider, model = rest[:sep], rest[sep+2:]
	if provider == "" || model == "" {
		return "", "", false
	}
	return provider, model, true
}

// claudeAliasForRoute mirrors aliasForRoute: alias for a routed
// "<provider>/<model>" pair, null when not representable.
func claudeAliasForRoute(provider, modelID string) (string, bool) {
	if provider == "" || strings.Contains(provider, "--") || strings.Contains(provider, "/") || provider == claudeNativeProvider {
		return "", false
	}
	if modelID == "" {
		return "", false
	}
	if claudeModelNeedsEscapeEncoding(modelID) {
		return claudeAliasPrefixV2 + provider + "--" + claudeEncodeModelID(modelID), true
	}
	return claudeAliasPrefixV1 + provider + "--" + modelID, true
}

// claudeAliasForNative mirrors aliasForNative: alias for a bare native slug.
func claudeAliasForNative(slug string) (string, bool) {
	if slug == "" || strings.Contains(slug, "/") || strings.Contains(slug, "--") {
		return "", false
	}
	if claudeModelNeedsEscapeEncoding(slug) {
		return claudeAliasPrefixV2 + claudeNativeProvider + "--" + claudeEncodeModelID(slug), true
	}
	return claudeAliasPrefixV1 + claudeNativeProvider + "--" + slug, true
}

// claudeResolveAlias mirrors resolveAlias: routed -> "<provider>/<model>",
// native -> bare slug. Ok=false when the id is not one of our aliases.
func claudeResolveAlias(id string) (string, bool) {
	if strings.HasPrefix(id, claudeAliasPrefixV2) {
		provider, model, ok := claudeSplitAlias(id, claudeAliasPrefixV2)
		if !ok {
			return "", false
		}
		decoded := claudeDecodeEscapedModelID(model)
		if decoded == "" {
			return "", false
		}
		if provider == claudeNativeProvider {
			return decoded, true
		}
		return provider + "/" + decoded, true
	}
	if strings.HasPrefix(id, claudeAliasPrefixV1) {
		provider, model, ok := claudeSplitAlias(id, claudeAliasPrefixV1)
		if !ok {
			return "", false
		}
		if provider == claudeNativeProvider {
			return model, true
		}
		return provider + "/" + model, true
	}
	return "", false
}

// claudeDesktop3pCode mirrors deriveDesktop3pCode: sha256 of the route, first
// 4 bytes big-endian modulo 33696, one letter + two base-36 digits.
func claudeDesktop3pCode(route string) string {
	sum := sha256.Sum256([]byte(route))
	n := binary.BigEndian.Uint32(sum[0:4]) % 33696
	first := string(rune('a' + n/1296))
	rest := strconv.FormatInt(int64(n%1296), 36)
	for len(rest) < 2 {
		rest = "0" + rest
	}
	return first + rest
}

// claudeDesktop3pAlias mirrors desktop3pAlias. Real Anthropic models pass
// through unchanged; everything else gets the claude-opus-4-8-{code} shape.
func claudeDesktop3pAlias(provider, modelID string) string {
	if provider == "anthropic" && strings.HasPrefix(modelID, "claude-") {
		return modelID
	}
	return desktop3pAliasPrefix + claudeDesktop3pCode(provider+"/"+modelID)
}

// claudeCodeAlias mirrors claudeCodeAlias: the readable claude-ocx* form when
// representable, otherwise the desktop3p hash. Anthropic claude-* ids pass
// through unchanged.
func claudeCodeAlias(provider, modelID string) string {
	if provider == "anthropic" && strings.HasPrefix(modelID, "claude-") {
		return modelID
	}
	if alias, ok := claudeAliasForRoute(provider, modelID); ok {
		return alias
	}
	return claudeDesktop3pAlias(provider, modelID)
}

// claudeCodeNativeAlias mirrors claudeCodeNativeAlias.
func claudeCodeNativeAlias(slug string) string {
	if alias, ok := claudeAliasForNative(slug); ok {
		return alias
	}
	return claudeDesktop3pAlias(claudeNativeProvider, slug)
}
