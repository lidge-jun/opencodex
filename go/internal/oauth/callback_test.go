package oauth

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

func TestCallbackServerRejectsWrongStateWithoutConsumingFlow(t *testing.T) {
	t.Parallel()
	server, err := StartCallbackServer(CallbackOptions{PreferredPort: 0, Timeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	wrong := callbackURL(server.RedirectURI, "wrong", "bad-code")
	response, err := http.Get(wrong)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("wrong-state status = %d, want 400", response.StatusCode)
	}

	wait := make(chan CallbackResult, 1)
	waitErr := make(chan error, 1)
	go func() {
		result, err := server.Wait(context.Background(), nil)
		wait <- result
		waitErr <- err
	}()
	valid := callbackURL(server.RedirectURI, server.State, "good-code")
	response, err = http.Get(valid)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("valid callback status = %d, want 200", response.StatusCode)
	}
	if result := <-wait; result.Code != "good-code" || result.State != server.State {
		t.Fatalf("Wait() result = %#v", result)
	}
	if err := <-waitErr; err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
}

func TestCallbackServerManualInputRace(t *testing.T) {
	t.Parallel()
	server, err := StartCallbackServer(CallbackOptions{PreferredPort: 0, Timeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	var attempts atomic.Int32
	manual := func(_ context.Context, state string) (string, error) {
		if attempts.Add(1) == 1 {
			return "?code=reject&state=wrong", nil
		}
		return "manual-code#" + state, nil
	}
	result, err := server.Wait(context.Background(), manual)
	if err != nil {
		t.Fatal(err)
	}
	if result.Code != "manual-code" || result.State != server.State || attempts.Load() != 2 {
		t.Fatalf("manual Wait() = %#v after %d attempts", result, attempts.Load())
	}
}

func TestParseCallbackInputKinds(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input string
		kind  CallbackInputKind
		code  string
		state string
	}{
		{"http://localhost/callback?code=a&state=b", CallbackInputURL, "a", "b"},
		{"?code=a&state=b", CallbackInputQuery, "a", "b"},
		{"a#b", CallbackInputRaw, "a", "b"},
	}
	for _, test := range tests {
		parsed := ParseCallbackInput(test.input)
		if parsed.Kind != test.kind || parsed.Code != test.code || parsed.State != test.state {
			t.Errorf("ParseCallbackInput(%q) = %#v", test.input, parsed)
		}
	}
}

func callbackURL(redirectURI, state, code string) string {
	parsed, _ := url.Parse(redirectURI)
	query := parsed.Query()
	query.Set("state", state)
	query.Set("code", code)
	parsed.RawQuery = query.Encode()
	return fmt.Sprint(parsed)
}
