package config

import "testing"

func TestNormalizeReasoningEffort(t *testing.T) {
	tests := []struct {
		input string
		want  string
		ok    bool
	}{
		{" minimal ", "low", true},
		{"XHIGH", "xhigh", true},
		{"none", "", false},
		{"turbo", "", false},
	}
	for _, tt := range tests {
		got, ok := NormalizeReasoningEffort(tt.input)
		if got != tt.want || ok != tt.ok {
			t.Errorf("NormalizeReasoningEffort(%q) = (%q, %v), want (%q, %v)", tt.input, got, ok, tt.want, tt.ok)
		}
	}
}

func TestMapReasoningEffort(t *testing.T) {
	got, ok := MapReasoningEffort("ultra", []string{"low", "high"}, map[string]string{"high": "heavy"})
	if !ok || got != "heavy" {
		t.Fatalf("MapReasoningEffort() = (%q, %v), want (heavy, true)", got, ok)
	}
}
