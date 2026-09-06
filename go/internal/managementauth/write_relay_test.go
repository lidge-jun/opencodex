package managementauth

import (
	"fmt"
	"testing"
)

const writeRelaySecret = "sidecar-private-bridge-secret"

func relayProof(nonce string, expiresAt int64) WriteRelayProof {
	return WriteRelayProof{Nonce: nonce, Principal: PrincipalAdminToken, Method: "PUT", Path: "/api/settings", ExpiresAt: expiresAt}
}

func TestWriteRelayProofBindsEveryMutationInputAndConsumesNonce(t *testing.T) {
	const now = int64(1800000000000)
	body := []byte("{\"streamMode\":\"eager-relay\"}")
	proof := relayProof(fmt.Sprintf("%043d", 1), now+1000)
	proof.Proof = CreateWriteRelayProof(writeRelaySecret, proof, body)
	if proof.Proof == "" {
		t.Fatal("CreateWriteRelayProof returned empty proof")
	}
	verifier := NewWriteRelayVerifier(writeRelaySecret).WithClock(func() int64 { return now })
	if !verifier.VerifyAndConsume(proof, body) {
		t.Fatal("valid relay proof was rejected")
	}
	if verifier.VerifyAndConsume(proof, body) {
		t.Fatal("replayed nonce was accepted")
	}
	for _, mutation := range []struct {
		name string
		edit func(*WriteRelayProof, *[]byte)
	}{
		{"body", func(_ *WriteRelayProof, b *[]byte) { *b = []byte("{\"streamMode\":\"auto\"}") }},
		{"principal", func(p *WriteRelayProof, _ *[]byte) { p.Principal = PrincipalGuiSession }},
		{"method", func(p *WriteRelayProof, _ *[]byte) { p.Method = "POST" }},
		{"path", func(p *WriteRelayProof, _ *[]byte) { p.Path = "/api/shadow-call-settings" }},
		{"expiry", func(p *WriteRelayProof, _ *[]byte) { p.ExpiresAt++ }},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			candidate := proof
			candidate.Nonce = fmt.Sprintf("%043d", 2)
			candidate.Proof = CreateWriteRelayProof(writeRelaySecret, candidate, body)
			candidateBody := append([]byte(nil), body...)
			mutation.edit(&candidate, &candidateBody)
			if NewWriteRelayVerifier(writeRelaySecret).WithClock(func() int64 { return now }).VerifyAndConsume(candidate, candidateBody) {
				t.Fatalf("proof with changed %s was accepted", mutation.name)
			}
		})
	}
}

func TestWriteRelayProofMatchesTypeScriptHMACFixture(t *testing.T) {
	body := []byte(`{"enabled":false}`)
	proof := WriteRelayProof{
		Nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Principal: PrincipalAdminToken,
		Method: "PUT", Path: "/api/shadow-call-settings", ExpiresAt: 1800000001000,
	}
	if got := CreateWriteRelayProof("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", proof, body); got != "_NzTNrMpPfCxQFlOn8gAkgKEaOnP9jP8nGBiLu3x4UI" {
		t.Fatalf("Go proof = %q; differs from TypeScript fixture", got)
	}
}

func TestWriteRelayProofRejectsExpiredInvalidAndSaturatedNonces(t *testing.T) {
	const now = int64(1800000000000)
	body := []byte("{}")
	verifier := NewWriteRelayVerifier(writeRelaySecret).WithClock(func() int64 { return now })
	for _, expiresAt := range []int64{now, now - 1, now + writeRelayTTLMillis + 1} {
		proof := relayProof(fmt.Sprintf("%043d", 1), expiresAt)
		proof.Proof = CreateWriteRelayProof(writeRelaySecret, proof, body)
		if verifier.VerifyAndConsume(proof, body) {
			t.Fatalf("expiry %d was accepted", expiresAt)
		}
	}
	if _, ok := ParseWriteRelayExpiry("001"); ok {
		t.Fatal("non-canonical expiry was accepted")
	}
	if CreateWriteRelayProof(writeRelaySecret, WriteRelayProof{Nonce: "bad", Principal: PrincipalAdminToken, Method: "PUT", Path: "/api/settings", ExpiresAt: now + 1}, body) != "" {
		t.Fatal("invalid nonce produced a proof")
	}
	for i := 0; i < WriteRelayReplayLimit; i++ {
		proof := relayProof(fmt.Sprintf("%043d", i+1), now+10000)
		proof.Proof = CreateWriteRelayProof(writeRelaySecret, proof, body)
		if !verifier.VerifyAndConsume(proof, body) {
			t.Fatalf("proof %d was rejected before the replay limit", i)
		}
	}
	extra := relayProof(fmt.Sprintf("%043d", WriteRelayReplayLimit+1), now+10000)
	extra.Proof = CreateWriteRelayProof(writeRelaySecret, extra, body)
	if verifier.VerifyAndConsume(extra, body) {
		t.Fatal("proof was accepted after replay table reached its limit")
	}
}
