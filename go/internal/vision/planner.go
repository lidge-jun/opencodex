package vision

import (
	"context"
	"strings"
	"sync"

	shared "github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	MaxVisionConcurrency          = 3
	DefaultMaxDescriptionsPerTurn = 8
)

type Backend string

const (
	BackendAuto      Backend = "auto"
	BackendOpenAI    Backend = "openai"
	BackendAnthropic Backend = "anthropic"
)

type PreprocessorConfig struct {
	Backend                Backend
	OpenAI                 *OpenAIConfig
	Anthropic              *AnthropicConfig
	Describer              Describer
	Cache                  *DescriptionCache
	Validation             ValidationOptions
	TextOnlyModels         []string
	SupportsVision         func(modelID string) bool
	MaxConcurrency         int
	MaxDescriptionsPerTurn int
}

// VisionPreprocessor describes images before adapters build requests for
// text-only targets. It is safe for concurrent use across turns.
type VisionPreprocessor struct {
	describer              Describer
	cache                  *DescriptionCache
	validation             ValidationOptions
	textOnlyModels         []string
	supportsVision         func(string) bool
	maxConcurrency         int
	maxDescriptionsPerTurn int
}

func NewVisionPreprocessor(config PreprocessorConfig) *VisionPreprocessor {
	describer := config.Describer
	if describer == nil {
		switch selectBackend(config) {
		case BackendAnthropic:
			if config.Anthropic != nil {
				describer = NewAnthropicMessagesDescriber(*config.Anthropic)
			}
		case BackendOpenAI:
			if config.OpenAI != nil {
				describer = NewOpenAIResponsesDescriber(*config.OpenAI)
			}
		}
	}
	cache := config.Cache
	if cache == nil {
		cache = NewDescriptionCache(DefaultCacheSize, DefaultCacheTTL)
	}
	concurrency := config.MaxConcurrency
	if concurrency <= 0 || concurrency > MaxVisionConcurrency {
		concurrency = MaxVisionConcurrency
	}
	maxDescriptions := config.MaxDescriptionsPerTurn
	if maxDescriptions <= 0 {
		maxDescriptions = DefaultMaxDescriptionsPerTurn
	}
	return &VisionPreprocessor{
		describer: describer, cache: cache, validation: config.Validation,
		textOnlyModels: append([]string(nil), config.TextOnlyModels...), supportsVision: config.SupportsVision,
		maxConcurrency: concurrency, maxDescriptionsPerTurn: maxDescriptions,
	}
}

func selectBackend(config PreprocessorConfig) Backend {
	if config.Backend == BackendOpenAI || config.Backend == BackendAnthropic {
		return config.Backend
	}
	if config.Anthropic != nil {
		return BackendAnthropic
	}
	return BackendOpenAI
}

// Preprocess checks the configured model capability and mutates req in place.
// Call it immediately before Adapter.BuildRequest.
func (p *VisionPreprocessor) Preprocess(ctx context.Context, req *shared.NormalizedRequest) error {
	if req == nil {
		return nil
	}
	supportsVision := true
	if p.supportsVision != nil {
		supportsVision = p.supportsVision(req.ModelID)
	} else if matchesModel(p.textOnlyModels, req.ModelID) {
		supportsVision = false
	}
	return p.PreprocessForModel(ctx, req, supportsVision)
}

// PreprocessForModel is the explicit integration form for callers that already
// resolved model capabilities.
func (p *VisionPreprocessor) PreprocessForModel(ctx context.Context, req *shared.NormalizedRequest, supportsVision bool) error {
	if req == nil || supportsVision {
		return nil
	}
	images, err := collectRequestImages(req, p.validation)
	if err != nil {
		return err
	}
	if len(images) == 0 {
		// Invalid image blocks still must not reach a text-only provider.
		_, err = ReplaceImages(req, nil)
		return err
	}
	if p.describer == nil {
		_, err = ReplaceImages(req, nil)
		return err
	}
	descriptions := p.describeUnique(ctx, images)
	replacements := make(map[imageLocation]string, len(images))
	for _, item := range images {
		replacements[imageLocation{item.messageIndex, item.partIndex}] = descriptions[item.key]
	}
	_, err = replaceRequestImages(req, replacements, sidecarFailedText)
	return err
}

func (p *VisionPreprocessor) describeUnique(ctx context.Context, images []requestImage) map[string]string {
	descriptions := make(map[string]string, len(images))
	unique := make([]requestImage, 0, len(images))
	seen := make(map[string]bool, len(images))
	for _, item := range images {
		if description, ok := p.cache.Get(item.key); ok {
			descriptions[item.key] = description
			continue
		}
		if seen[item.key] || len(unique) >= p.maxDescriptionsPerTurn {
			continue
		}
		seen[item.key] = true
		unique = append(unique, item)
	}
	if len(unique) == 0 {
		return descriptions
	}
	jobs := make(chan requestImage)
	var wg sync.WaitGroup
	var mu sync.Mutex
	workerCount := min(p.maxConcurrency, len(unique))
	for range workerCount {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				description, err := p.describer.Describe(ctx, item.image, item.contextText)
				description = strings.TrimSpace(description)
				if err != nil || description == "" {
					continue
				}
				description = clampDescription(description)
				p.cache.Set(item.key, description)
				mu.Lock()
				descriptions[item.key] = description
				mu.Unlock()
			}
		}()
	}
	for _, item := range unique {
		jobs <- item
	}
	close(jobs)
	wg.Wait()
	return descriptions
}

func matchesModel(models []string, modelID string) bool {
	modelID = strings.ToLower(strings.TrimSpace(modelID))
	for _, candidate := range models {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == modelID || strings.HasSuffix(modelID, "/"+candidate) {
			return true
		}
	}
	return false
}
