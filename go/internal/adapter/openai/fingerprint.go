package openai

import (
	"crypto/sha256"
	"fmt"
	"runtime"
	"strings"
)

const (
	AntigravityCLIVersion        = "1.0.13"
	AntigravityGoogleAPIClientUA = "google-api-nodejs-client/10.3.0"
)

func ClaudeCodeHeaders() map[string]string {
	return map[string]string{
		"X-App":                       "cli",
		"X-Stainless-Retry-Count":     "0",
		"X-Stainless-Runtime":         "go",
		"X-Stainless-Lang":            "go",
		"X-Stainless-Timeout":         "600",
		"X-Stainless-Arch":            runtime.GOARCH,
		"X-Stainless-OS":              runtime.GOOS,
		"X-Stainless-Package-Version": "0.74.0",
		"X-Stainless-Runtime-Version": strings.TrimPrefix(runtime.Version(), "go"),
	}
}

func ClaudeCodeSessionID(token string) string {
	if token == "" {
		token = "opencodex-anon"
	}
	digest := sha256.Sum256([]byte("claude-code-session:" + token))
	hex := fmt.Sprintf("%x", digest[:])
	variant := "89ab"[digest[8]&3]
	return fmt.Sprintf("%s-%s-4%s-%c%s-%s", hex[:8], hex[8:12], hex[13:16], variant, hex[17:20], hex[20:32])
}

func AntigravityUserAgent(version string) string {
	if version == "" {
		version = AntigravityCLIVersion
	}
	return fmt.Sprintf("antigravity/cli/%s (aidev_client; os_type=darwin; arch=arm64)", version)
}
