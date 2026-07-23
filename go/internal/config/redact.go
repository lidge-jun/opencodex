package config

import (
	"fmt"
	"regexp"
	"strings"
)

const RedactedSecret = "[REDACTED]"

var (
	sensitiveKeyPattern = regexp.MustCompile(`(?i)^(authorization|proxy-authorization|cookie|set-cookie2?|api[-_]?key|x-api-key|x-goog-api-key|x-amz-security-token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|profile[-_]?arn)$`)
	bearerPattern       = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`)
	secretTokenPattern  = regexp.MustCompile(`\b(?:sk-[A-Za-z0-9][A-Za-z0-9._-]{6,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{20,})\b`)
	assignmentPattern   = regexp.MustCompile(`(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|refreshToken|accessToken|clientSecret|apiKey)=([^&\s"',;]+)`)
	jsonSecretPattern   = regexp.MustCompile(`(?i)("(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|refreshToken|accessToken|clientSecret|apiKey)"\s*:\s*")([^"]+)(")`)
)

func RedactString(value string) string {
	value = bearerPattern.ReplaceAllString(value, "Bearer "+RedactedSecret)
	value = secretTokenPattern.ReplaceAllString(value, RedactedSecret)
	value = assignmentPattern.ReplaceAllString(value, "$1="+RedactedSecret)
	value = jsonSecretPattern.ReplaceAllString(value, "$1"+RedactedSecret+"$3")
	return value
}

// RedactMap returns a deep redacted copy of JSON-like map and slice values.
func RedactMap(value map[string]any) map[string]any {
	redacted := make(map[string]any, len(value))
	for key, item := range value {
		if sensitiveKeyPattern.MatchString(key) {
			redacted[key] = RedactedSecret
			continue
		}
		redacted[key] = redactValue(item)
	}
	return redacted
}

func redactValue(value any) any {
	switch v := value.(type) {
	case string:
		return RedactString(v)
	case map[string]any:
		return RedactMap(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = redactValue(item)
		}
		return out
	case fmt.Stringer:
		return RedactString(v.String())
	default:
		return value
	}
}

func IsSensitiveKey(key string) bool {
	return sensitiveKeyPattern.MatchString(strings.TrimSpace(key))
}
