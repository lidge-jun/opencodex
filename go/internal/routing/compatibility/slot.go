// Package compatibility hosts the core-owned slot for the optional
// compatibility-evidence provider (ADR-0008, ticket #19), mirroring
// src/routing/compatibility/provider-slot.ts.
//
// Routing in Go does not exist yet — this is the seam, established now so the
// "registers at activation" contract is reproducible and testable before any
// Lab content arrives. The slot is a nullable provider reference installed
// only during activation: an install that never activates Lab never registers
// one, exactly like the TypeScript core, whose synchronous evidence assembler
// consults resolveCompatibilityEvidenceProvider and therefore must never pull
// the Lab module graph in.
//
// The provider is typed opaquely for now: the concrete profile/policy/options
// shapes belong to the Go routing port, and forcing them here would churn
// this file twice. When ticket #33 ports the Lab evidence provider the
// signature is refined to the routing types without changing the slot
// semantics this package pins.
package compatibility

import "sync"

// EvidenceOptions is the opaque carrier for whatever the routing assembler can
// supply without knowing anything Lab-specific (see CoreEvidenceOptions in the
// TS slot). Refined by the routing port.
type EvidenceOptions = map[string]any

// CandidateEvidence is one provider/model → evidence projection. Refined by
// the routing port; until then the empty map is the honest "no Lab content
// registered" value rather than a pretend provider.
type CandidateEvidence = map[string]any

// EvidenceProvider produces compatibility evidence per candidate. Mirrors the
// CompatibilityEvidenceProvider function type in the TS slot.
type EvidenceProvider func(options EvidenceOptions) CandidateEvidence

// Slot is the core-owned nullable provider reference.
type Slot struct {
	mu        sync.RWMutex
	installed *registration
}

// registration carries identity so a detach removes only its own install even
// when a later activation replaced it (the TS detach compares with ===).
type registration struct {
	provider EvidenceProvider
}

// NewSlot returns an empty slot: no provider registered.
func NewSlot() *Slot {
	return &Slot{}
}

// Set installs the provider and returns a detach function. Mirrors
// setCompatibilityEvidenceProvider.
func (s *Slot) Set(next EvidenceProvider) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	reg := &registration{provider: next}
	s.installed = reg
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.installed == reg {
			s.installed = nil
		}
	}
}

// Resolve returns the installed provider, or nil when no optional subsystem is
// active. Mirrors resolveCompatibilityEvidenceProvider.
func (s *Slot) Resolve() EvidenceProvider {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.installed == nil {
		return nil
	}
	return s.installed.provider
}

// Reset clears the slot (test isolation only; mirrors
// resetCompatibilityEvidenceProviderForTests).
func (s *Slot) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.installed = nil
}
