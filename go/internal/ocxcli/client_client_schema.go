package ocxcli

// Client-block schema classification (src/config.ts clientConnectionSchema).
// readClientConnectionState treats a role=client block that fails zod parsing
// as invalid, with the reason taken from the FIRST zod issue path — the field
// sequence matters, and the warning text is path-derived only:
//
//	client.<joined path> invalid: remote client mode is disabled until
//	config.json is repaired
//
// The checks below run in the same declaration order zod uses so the joined
// path matches for every realistic malformation (wrong type, format, or a
// malformed nested rotation marker).

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// hex64ClientPattern validates tokenFingerprint: z.string().regex(/^[a-f0-9]{64}$/).
var hex64ClientPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// canonicalHTTPOrigin mirrors canonicalHttpOrigin in src/config.ts: a URL whose
// only meaningful parts are scheme + host (no credentials, path "/", no query
// or fragment). Returns the canonical origin, "" when the value is rejected.
func canonicalHTTPOrigin(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	if parsed.User != nil {
		return ""
	}
	// url.Parse leaves the path "" where new URL() normalizes it to "/"; the
	// equivalent constraint is "the URL carries no path".
	if path := parsed.EscapedPath(); path != "" && path != "/" {
		return ""
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	if parsed.Host == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

// isClientTimestamp mirrors z.string().datetime({offset:true}): RFC 3339 with a
// timezone offset. Seeds are valid RFC 3339 values, so zod-level strictness
// beyond what time.Parse accepts does not shift classification.
func isClientTimestamp(value any) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, text)
	return err == nil
}

// pendingOperationBackupPath is the exact path zod's superRefine demands of
// pendingOperation.oldKeyBackupPath (join(getConfigDir(), service-api-token.prev)).
func pendingOperationBackupPath() string {
	dir, err := config.Dir()
	if err != nil {
		return ""
	}
	return serviceAPITokenBackupPath(dir)
}

// firstClientIssuePath re-validates a raw client block. It returns the joined
// zod issue path of the FIRST failing field and true when the block is
// schema-invalid, or ("", false) when the block validates. Fields are checked
// in clientConnectionSchema declaration order; an unknown top-level key is
// reported only after every declared field has passed (zod appends its strict
// "unrecognized_keys" issue last) and yields the empty field, exactly like a
// schema that rejected a non-object value.
func firstClientIssuePath(raw any) (string, bool) {
	block, ok := raw.(map[string]any)
	if !ok {
		return "", true
	}
	originField := func(key string) bool {
		value, present := block[key]
		if !present {
			return false
		}
		text, isString := value.(string)
		return isString && canonicalHTTPOrigin(text) != ""
	}
	if !originField("serverUrl") {
		return "serverUrl", true
	}
	if !originField("managementUrl") {
		return "managementUrl", true
	}
	if value, present := block["managementTransport"]; !present {
		return "managementTransport", true
	} else if text, ok := value.(string); !ok || (text != "direct" && text != "relay") {
		return "managementTransport", true
	}
	// selectedClients: z.array(...).min(1).max(2) with per-element literals and
	// a duplicate refinement. Array-level constraints fire before element issues.
	if value, present := block["selectedClients"]; !present {
		return "selectedClients", true
	} else {
		list, ok := value.([]any)
		if !ok {
			return "selectedClients", true
		}
		if len(list) < 1 || len(list) > 2 {
			return "selectedClients", true
		}
		seen := make(map[string]bool, len(list))
		for index, item := range list {
			text, isString := item.(string)
			if !isString || (text != "codex" && text != "claude") {
				return fmt.Sprintf("selectedClients.%d", index), true
			}
			seen[text] = true
		}
		if len(seen) != len(list) {
			return "selectedClients", true
		}
	}
	if value, present := block["tokenEnv"]; !present {
		return "tokenEnv", true
	} else if text, ok := value.(string); !ok || text != "OPENCODEX_API_AUTH_TOKEN" {
		return "tokenEnv", true
	}
	if value, present := block["apiKeyId"]; !present {
		return "apiKeyId", true
	} else if text, ok := value.(string); !ok {
		return "apiKeyId", true
	} else if trimmed := strings.TrimSpace(text); len(trimmed) < 1 || len(trimmed) > 256 {
		return "apiKeyId", true
	}
	if value, present := block["tokenFingerprint"]; !present {
		return "tokenFingerprint", true
	} else if text, ok := value.(string); !ok || !hex64ClientPattern.MatchString(text) {
		return "tokenFingerprint", true
	}
	if value, present := block["protocolVersion"]; !present {
		return "protocolVersion", true
	} else if number, ok := value.(float64); !ok || number != 1 {
		return "protocolVersion", true
	}
	if value, present := block["connectedAt"]; !present {
		return "connectedAt", true
	} else if !isClientTimestamp(value) {
		return "connectedAt", true
	}
	if value, present := block["catalogFingerprint"]; present {
		text, ok := value.(string)
		if !ok || len(text) < 1 || len(text) > 512 {
			return "catalogFingerprint", true
		}
	}
	if value, present := block["priorCatalog"]; present {
		text, ok := value.(string)
		if !ok || len(text) > 64*1024*1024 {
			return "priorCatalog", true
		}
	}
	if value, present := block["catalogSyncedAt"]; present && !isClientTimestamp(value) {
		return "catalogSyncedAt", true
	}
	if value, present := block["pendingOperation"]; present {
		op, isObject := value.(map[string]any)
		if !isObject {
			return "pendingOperation", true
		}
		if kind, present := op["kind"]; !present {
			return "pendingOperation.kind", true
		} else if text, ok := kind.(string); !ok || text != "rotate" {
			return "pendingOperation.kind", true
		}
		if rotationID, present := op["rotationId"]; !present {
			return "pendingOperation.rotationId", true
		} else if text, ok := rotationID.(string); !ok {
			return "pendingOperation.rotationId", true
		} else if trimmed := strings.TrimSpace(text); len(trimmed) < 1 || len(trimmed) > 256 {
			return "pendingOperation.rotationId", true
		}
		if issuedAt, present := op["newKeyIssuedAt"]; !present {
			return "pendingOperation.newKeyIssuedAt", true
		} else if !isClientTimestamp(issuedAt) {
			return "pendingOperation.newKeyIssuedAt", true
		}
		if backupPath, present := op["oldKeyBackupPath"]; !present {
			return "pendingOperation.oldKeyBackupPath", true
		} else if text, ok := backupPath.(string); !ok || text != pendingOperationBackupPath() {
			return "pendingOperation.oldKeyBackupPath", true
		}
		for key := range op {
			switch key {
			case "kind", "rotationId", "newKeyIssuedAt", "oldKeyBackupPath":
			default:
				return "pendingOperation", true
			}
		}
	}
	for key := range block {
		switch key {
		case "serverUrl", "managementUrl", "managementTransport", "selectedClients",
			"tokenEnv", "apiKeyId", "tokenFingerprint", "protocolVersion", "connectedAt",
			"catalogFingerprint", "priorCatalog", "catalogSyncedAt", "pendingOperation":
		default:
			// zod strict unknown-key issue carries path [].
			return "", true
		}
	}
	return "", false
}
