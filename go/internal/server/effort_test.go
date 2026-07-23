package server

import "testing"

func TestResolveCappedEffort(t *testing.T) {
	got, keep := ResolveCappedEffort("max", "high", []string{"low", "medium", "high", "max"})
	if !keep || got != "high" {
		t.Fatalf("got (%q, %v)", got, keep)
	}
	if got, keep = ResolveCappedEffort("high", "low", []string{}); keep || got != "" {
		t.Fatalf("strip got (%q, %v)", got, keep)
	}
}
