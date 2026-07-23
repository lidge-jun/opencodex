package openai

import "strings"

const (
	CodexGPT5IdentityLine  = "You are Codex, a coding agent based on GPT-5."
	NeutralIdentityLine    = "You are a coding agent. Do not claim to be GPT-5 or to be made by OpenAI."
	NeutralIdentityCatalog = NeutralIdentityLine
)

// NeutralizeIdentity removes only Codex's exact hard-coded OpenAI identity.
func NeutralizeIdentity(systemText string) string {
	return strings.Replace(systemText, CodexGPT5IdentityLine, NeutralIdentityLine, 1)
}
