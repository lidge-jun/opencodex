package server

import (
	"regexp"
	"strings"
)

var fernetToken = regexp.MustCompile(`gAAAAA[A-Za-z0-9_-]{40,}`)

// LooksLikeBackendCiphertext identifies opaque Fernet-style backend payloads.
func LooksLikeBackendCiphertext(value string) bool {
	return fernetToken.MatchString(strings.TrimSpace(value))
}

// HasUnreadableEncryptedPayload reports whether an agent message contains ciphertext and no readable task text.
func HasUnreadableEncryptedPayload(input any) bool {
	items, ok := input.([]any)
	if !ok {
		return false
	}
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok || item["type"] != "agent_message" {
			continue
		}
		content, ok := item["content"].([]any)
		if !ok {
			continue
		}
		hasCipher, readable := false, false
		for _, partValue := range content {
			part, ok := partValue.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok && strings.TrimSpace(text) != "" {
				readable = true
			}
			if encrypted, ok := part["encrypted_content"].(string); ok && LooksLikeBackendCiphertext(encrypted) {
				hasCipher = true
			}
		}
		if hasCipher && !readable {
			return true
		}
	}
	return false
}

// SanitizeEncryptedPayload rewrites plaintext mislabeled as encrypted_content to input_text.
func SanitizeEncryptedPayload(input any) int {
	rewritten := 0
	var visit func(any)
	visit = func(value any) {
		switch node := value.(type) {
		case []any:
			for _, child := range node {
				visit(child)
			}
		case map[string]any:
			if node["type"] == "encrypted_content" {
				if payload, ok := node["encrypted_content"].(string); ok && !LooksLikeBackendCiphertext(payload) {
					node["type"], node["text"] = "input_text", payload
					delete(node, "encrypted_content")
					rewritten++
				}
			}
			for _, child := range node {
				visit(child)
			}
		}
	}
	visit(input)
	return rewritten
}
