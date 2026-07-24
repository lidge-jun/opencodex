// Package generated contains the Go runtime's embedded model metadata snapshot.
package generated

import "sort"

// Modality describes an input type accepted by a model.
type Modality string

const (
	ModalityText  Modality = "text"
	ModalityImage Modality = "image"
)

// Price contains provider pricing in US dollars per one million tokens.
type Price struct {
	InputPerMillion  float64
	OutputPerMillion float64
}

// Calculate returns the estimated input and output cost in US dollars.
func (p Price) Calculate(inputTokens, outputTokens int) float64 {
	return float64(inputTokens)*p.InputPerMillion/1_000_000 +
		float64(outputTokens)*p.OutputPerMillion/1_000_000
}

// ModelMetadata is the representative subset of jawcode model metadata used by
// the Go runtime. Pricing is expressed in US dollars per one million tokens.
type ModelMetadata struct {
	Provider      string
	ID            string
	ContextWindow int
	MaxTokens     int
	Input         []Modality
	Reasoning     bool
	WireModelID   string
	Price         *Price
}

var modelMetadata = map[string]map[string]ModelMetadata{
	"openai": {
		"gpt-5":         model("openai", "gpt-5", 400_000, 128_000, textImage, true, "", 1.25, 10),
		"gpt-5-mini":    model("openai", "gpt-5-mini", 400_000, 128_000, textImage, true, "", 0.25, 2),
		"gpt-5.2-codex": model("openai", "gpt-5.2-codex", 272_000, 128_000, textImage, true, "", 1.75, 14),
		"gpt-5.4":       model("openai", "gpt-5.4", 1_050_000, 128_000, textImage, true, "", 2.5, 15),
		"gpt-5.6-luna":  model("openai", "gpt-5.6-luna", 373_000, 128_000, textImage, true, "", 1, 6),
		"gpt-5.6-sol":   model("openai", "gpt-5.6-sol", 373_000, 128_000, textImage, true, "", 5, 30),
		"gpt-5.6-terra": model("openai", "gpt-5.6-terra", 373_000, 128_000, textImage, true, "", 2.5, 15),
		"gpt-4o-mini":   model("openai", "gpt-4o-mini", 128_000, 16_384, textImage, false, "", 0.15, 0.6),
	},
	"anthropic": {
		"claude-haiku-4-5":    model("anthropic", "claude-haiku-4-5", 200_000, 64_000, textImage, true, "", 1, 5),
		"claude-opus-4-6":     model("anthropic", "claude-opus-4-6", 1_000_000, 128_000, textImage, true, "", 5, 25),
		"claude-opus-4-6[1m]": model("anthropic", "claude-opus-4-6[1m]", 1_000_000, 128_000, textImage, true, "claude-opus-4-6", 5, 25),
		"claude-sonnet-4-5":   model("anthropic", "claude-sonnet-4-5", 1_000_000, 64_000, textImage, true, "", 3, 15),
		"claude-sonnet-5":     model("anthropic", "claude-sonnet-5", 1_000_000, 128_000, textImage, true, "", 2, 10),
	},
	"google": {
		"gemini-2.5-flash": model("google", "gemini-2.5-flash", 1_048_576, 65_536, textImage, true, "", 0.3, 2.5),
		"gemini-2.5-pro":   model("google", "gemini-2.5-pro", 1_048_576, 65_536, textImage, true, "", 1.25, 10),
		"gemini-2.0-flash": model("google", "gemini-2.0-flash", 1_048_576, 8_192, textImage, false, "", 0.1, 0.4),
		"gemma-3-27b-it":   model("google", "gemma-3-27b-it", 131_072, 8_192, textImage, false, "", 0, 0),
	},
	"xai": {
		"grok-3":           model("xai", "grok-3", 131_072, 8_192, textOnly, false, "", 3, 15),
		"grok-3-mini":      model("xai", "grok-3-mini", 131_072, 8_192, textOnly, true, "", 0.3, 0.5),
		"grok-4-fast":      model("xai", "grok-4-fast", 2_000_000, 30_000, textImage, true, "", 0.2, 0.5),
		"grok-code-fast-1": model("xai", "grok-code-fast-1", 256_000, 10_000, textOnly, true, "", 0.2, 1.5),
	},
	"deepseek": {
		"deepseek-v4-flash": model("deepseek", "deepseek-v4-flash", 1_000_000, 384_000, textOnly, true, "", 0.14, 0.28),
		"deepseek-v4-pro":   model("deepseek", "deepseek-v4-pro", 1_000_000, 384_000, textOnly, true, "", 0.435, 0.87),
	},
	"moonshot": {
		"kimi-k2.5": model("moonshot", "kimi-k2.5", 262_144, 65_536, textImage, true, "", 0, 0),
	},
	"minimax": {
		"MiniMax-M2.5": model("minimax", "MiniMax-M2.5", 204_800, 131_072, textOnly, true, "", 0.3, 1.2),
		"MiniMax-M3":   model("minimax", "MiniMax-M3", 1_000_000, 128_000, textImage, true, "", 0.3, 1.2),
	},
}

var (
	textOnly  = []Modality{ModalityText}
	textImage = []Modality{ModalityText, ModalityImage}
)

func model(provider, id string, contextWindow, maxTokens int, input []Modality, reasoning bool, wireModelID string, inputPrice, outputPrice float64) ModelMetadata {
	return ModelMetadata{
		Provider: provider, ID: id, ContextWindow: contextWindow, MaxTokens: maxTokens,
		Input: append([]Modality(nil), input...), Reasoning: reasoning, WireModelID: wireModelID,
		Price: &Price{InputPerMillion: inputPrice, OutputPerMillion: outputPrice},
	}
}

// GetModelMetadata returns a defensive copy of metadata for an exact provider
// and model ID, or nil when the pair is unknown.
func GetModelMetadata(provider, modelID string) *ModelMetadata {
	models, ok := modelMetadata[provider]
	if !ok {
		return nil
	}
	metadata, ok := models[modelID]
	if !ok {
		return nil
	}
	return cloneMetadata(metadata)
}

// ListModels returns provider models sorted by model ID.
func ListModels(provider string) []ModelMetadata {
	models := modelMetadata[provider]
	result := make([]ModelMetadata, 0, len(models))
	for _, metadata := range models {
		result = append(result, *cloneMetadata(metadata))
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

// GetPrice returns a defensive copy of per-million-token pricing, or nil when
// the provider/model pair is unknown.
func GetPrice(provider, modelID string) *Price {
	metadata := GetModelMetadata(provider, modelID)
	if metadata == nil || metadata.Price == nil {
		return nil
	}
	price := *metadata.Price
	return &price
}

func cloneMetadata(metadata ModelMetadata) *ModelMetadata {
	copy := metadata
	copy.Input = append([]Modality(nil), metadata.Input...)
	if metadata.Price != nil {
		price := *metadata.Price
		copy.Price = &price
	}
	return &copy
}
