package registry

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestAPIKeyPoolRotatesAndHonorsCooldown(t *testing.T) {
	pool := NewAPIKeyPool("first-secret", "second-secret", "third-secret")
	now := time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC)
	first, ok := pool.Active()
	if !ok || first.Value != "first-secret" {
		t.Fatalf("initial active key = %#v, %v", first, ok)
	}
	second, ok := pool.RotateOn429(first.ID, "120", now)
	if !ok || second.Value != "second-secret" {
		t.Fatalf("first rotation = %#v, %v", second, ok)
	}
	third, ok := pool.RotateOn429(second.ID, "60", now)
	if !ok || third.Value != "third-secret" {
		t.Fatalf("second rotation = %#v, %v", third, ok)
	}
	if _, ok := pool.RotateOn429(third.ID, "60", now); ok {
		t.Fatal("rotation should fail while every key is cooling down")
	}

	afterMinute := now.Add(61 * time.Second)
	second, ok = pool.RotateOn429(third.ID, "60", afterMinute)
	if !ok || second.Value != "second-secret" {
		t.Fatalf("expired cooldown rotation = %#v, %v", second, ok)
	}
}

func TestCredentialStructsDoNotSerializeSecrets(t *testing.T) {
	payload, err := json.Marshal(struct {
		Key     APIKey       `json:"key"`
		Account CodexAccount `json:"account"`
	}{
		Key:     APIKey{ID: "id", Value: "key-secret"},
		Account: CodexAccount{ID: "account", AccessToken: "token-secret", Headers: map[string]string{"Authorization": "header-secret"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	for _, secret := range []string{"key-secret", "token-secret", "header-secret"} {
		if strings.Contains(text, secret) {
			t.Fatalf("serialized secret %q in %s", secret, text)
		}
	}
}

func TestAPIKeyPoolConcurrentAttemptDoesNotCoolReplacement(t *testing.T) {
	pool := NewAPIKeyPool("first-secret", "second-secret")
	now := time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC)
	first, _ := pool.Active()
	second, ok := pool.RotateOn429(first.ID, "60", now)
	if !ok {
		t.Fatal("expected first rotation")
	}
	got, ok := pool.RotateOn429(first.ID, "60", now)
	if !ok || got.ID != second.ID {
		t.Fatalf("late 429 rotated healthy replacement: %#v, %v", got, ok)
	}
}
