package generated

import (
	"math"
	"testing"
)

func TestGetModelMetadataKnownModel(t *testing.T) {
	metadata := GetModelMetadata("anthropic", "claude-opus-4-6[1m]")
	if metadata == nil {
		t.Fatal("GetModelMetadata() = nil")
	}
	if metadata.Provider != "anthropic" || metadata.ContextWindow != 1_000_000 || metadata.WireModelID != "claude-opus-4-6" {
		t.Fatalf("metadata = %#v", metadata)
	}
	if len(metadata.Input) != 2 || metadata.Input[1] != ModalityImage || !metadata.Reasoning {
		t.Fatalf("capabilities = %#v", metadata)
	}
}

func TestGetModelMetadataUnknownModel(t *testing.T) {
	if metadata := GetModelMetadata("openai", "does-not-exist"); metadata != nil {
		t.Fatalf("GetModelMetadata() = %#v, want nil", metadata)
	}
	if price := GetPrice("does-not-exist", "gpt-5"); price != nil {
		t.Fatalf("GetPrice() = %#v, want nil", price)
	}
}

func TestPriceCalculation(t *testing.T) {
	price := GetPrice("openai", "gpt-5")
	if price == nil {
		t.Fatal("GetPrice() = nil")
	}
	got := price.Calculate(2_000_000, 500_000)
	want := 7.5
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("Calculate() = %v, want %v", got, want)
	}
}

func TestListModelsByProvider(t *testing.T) {
	models := ListModels("xai")
	if len(models) != 4 {
		t.Fatalf("ListModels(xai) count = %d, want 4", len(models))
	}
	if models[0].ID != "grok-3" || models[3].ID != "grok-code-fast-1" {
		t.Fatalf("ListModels(xai) = %#v", models)
	}
	models[0].Input[0] = ModalityImage
	if again := GetModelMetadata("xai", "grok-3"); again.Input[0] != ModalityText {
		t.Fatal("ListModels returned mutable package metadata")
	}
	if unknown := ListModels("unknown"); len(unknown) != 0 {
		t.Fatalf("ListModels(unknown) = %#v", unknown)
	}
}
