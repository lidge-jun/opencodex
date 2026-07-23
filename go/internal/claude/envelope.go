package claude

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

const ReasoningEnvelopePrefix = "ocxr1:"

type ReasoningEnvelope struct {
	Signature string   `json:"sig,omitempty"`
	Redacted  []string `json:"red,omitempty"`
	Text      string   `json:"txt,omitempty"`
}

func EncodeReasoningEnvelope(e ReasoningEnvelope) string {
	b, _ := json.Marshal(e)
	return ReasoningEnvelopePrefix + base64.StdEncoding.EncodeToString(b)
}

func DecodeReasoningEnvelope(value string) (ReasoningEnvelope, bool) {
	if !strings.HasPrefix(value, ReasoningEnvelopePrefix) {
		return ReasoningEnvelope{}, false
	}
	b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, ReasoningEnvelopePrefix))
	if err != nil {
		return ReasoningEnvelope{}, false
	}
	var e ReasoningEnvelope
	if json.Unmarshal(b, &e) != nil || (e.Signature == "" && len(e.Redacted) == 0 && e.Text == "") {
		return ReasoningEnvelope{}, false
	}
	return e, true
}
