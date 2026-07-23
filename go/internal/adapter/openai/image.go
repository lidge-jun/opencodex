package openai

import (
	"encoding/base64"
	"fmt"
	"strings"
)

type DataURL struct {
	MediaType string
	Base64    string
}

// ParseDataURL splits a base64 data URL without decoding its potentially large payload.
func ParseDataURL(value string) (*DataURL, error) {
	if !strings.HasPrefix(value, "data:") {
		return nil, nil
	}
	header, payload, ok := strings.Cut(strings.TrimPrefix(value, "data:"), ",")
	if !ok {
		return nil, fmt.Errorf("invalid data URL: missing comma")
	}
	mediaType, encoding, ok := strings.Cut(header, ";")
	if !ok || !strings.EqualFold(encoding, "base64") || strings.TrimSpace(mediaType) == "" {
		return nil, fmt.Errorf("invalid data URL: expected media type and base64 encoding")
	}
	if payload == "" {
		return nil, fmt.Errorf("invalid data URL: empty payload")
	}
	if _, err := base64.StdEncoding.DecodeString(payload); err != nil {
		return nil, fmt.Errorf("invalid data URL payload: %w", err)
	}
	return &DataURL{MediaType: mediaType, Base64: payload}, nil
}
