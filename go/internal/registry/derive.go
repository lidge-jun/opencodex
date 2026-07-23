package registry

// LoginProvider is the provider projection used by login/setup surfaces.
type LoginProvider struct {
	ID           string
	Label        string
	Adapter      string
	BaseURL      string
	AuthKind     AuthKind
	DashboardURL string
	DefaultModel string
	OAuthID      string
	KeyOptional  bool
	FreeTier     bool
}

type ProviderPreset = LoginProvider

func DeriveLoginMap(entries []Provider) map[string]LoginProvider {
	out := make(map[string]LoginProvider, len(entries))
	for _, entry := range entries {
		out[entry.ID] = loginProjection(entry)
	}
	return out
}

func DeriveKeyLoginMap(entries []Provider) map[string]LoginProvider {
	out := make(map[string]LoginProvider)
	for _, entry := range entries {
		if entry.AuthKind == AuthKey {
			out[entry.ID] = loginProjection(entry)
		}
	}
	return out
}

func DeriveOAuthLoginMap(entries []Provider) map[string]LoginProvider {
	out := make(map[string]LoginProvider)
	for _, entry := range entries {
		if entry.AuthKind == AuthOAuth {
			out[entry.ID] = loginProjection(entry)
		}
	}
	return out
}

func DeriveProviderPresets(entries []Provider) []ProviderPreset {
	seen := make(map[string]struct{})
	out := make([]ProviderPreset, 0, len(entries)+1)
	for _, entry := range entries {
		if !entry.Featured && entry.AuthKind != AuthKey && !entry.DashboardPreset {
			continue
		}
		if _, ok := seen[entry.ID]; ok {
			continue
		}
		seen[entry.ID] = struct{}{}
		out = append(out, loginProjection(entry))
	}
	out = append(out, ProviderPreset{ID: "custom", Label: "Custom provider", Adapter: "openai-chat", AuthKind: AuthKey})
	return out
}

func DeriveAliases(entries []Provider) map[string]string {
	out := make(map[string]string)
	for _, entry := range entries {
		if entry.OAuthID != "" && entry.OAuthID != entry.ID {
			out[entry.OAuthID] = entry.ID
		}
	}
	// Historical public provider identities.
	out["chatgpt"] = OpenAICodexProviderID
	out[LegacyOpenAIMultiProviderID] = OpenAICodexProviderID
	out["antigravity"] = "google-antigravity"
	out["gemini-antigravity"] = "google-antigravity"
	out["gemini-vertex"] = "google-vertex"
	return out
}

func loginProjection(entry Provider) LoginProvider {
	oauthID := entry.OAuthID
	if oauthID == "" {
		oauthID = entry.ID
	}
	return LoginProvider{ID: entry.ID, Label: entry.Label, Adapter: entry.Adapter, BaseURL: entry.BaseURL, AuthKind: entry.AuthKind, DashboardURL: entry.DashboardURL, DefaultModel: entry.DefaultModel, OAuthID: oauthID, KeyOptional: entry.KeyOptional, FreeTier: entry.FreeTier}
}
