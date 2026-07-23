package openai

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	MimoBootstrapURL = "https://api.xiaomimimo.com/api/free-ai/bootstrap"
	MimoChatURL      = "https://api.xiaomimimo.com/api/free-ai/openai/chat"
	MimoSystemMarker = "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks."
	mimoFallbackTTL  = 50 * time.Minute
	mimoExpiryBuffer = 5 * time.Minute
)

var mimoUserAgents = []string{
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
}

type MimoAdapter struct {
	Client       *http.Client
	BootstrapURL string
	ChatURL      string
	ConfigDir    string
	Chat         ChatAdapter
	SessionID    string

	mu          sync.Mutex
	jwt         string
	jwtExpires  time.Time
	jwtInflight chan struct{}
	jwtErr      error
	clientID    string
}

var _ types.Adapter = (*MimoAdapter)(nil)

func NewMimoAdapter() *MimoAdapter {
	return &MimoAdapter{Client: NewHTTPClient(0), SessionID: "ses_" + randomHex(12)}
}

func (a *MimoAdapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	jwt, err := a.getJWT(ctx)
	if err != nil {
		return nil, err
	}
	base := a.Chat
	base.Client = a.httpClient()
	if base.BaseURL == "" {
		base.BaseURL = "https://api.openai.com/v1"
	}
	httpReq, err := base.BuildRequest(ctx, req)
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if err := json.NewDecoder(httpReq.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode MiMo chat body: %w", err)
	}
	_ = httpReq.Body.Close()
	body = InjectMimoSystemMarker(body)
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal MiMo chat body: %w", err)
	}
	chatURL := a.ChatURL
	if chatURL == "" {
		chatURL = MimoChatURL
	}
	parsedURL, err := urlForRequest(chatURL)
	if err != nil {
		return nil, err
	}
	httpReq.URL = parsedURL
	httpReq.Body = io.NopCloser(bytes.NewReader(payload))
	httpReq.ContentLength = int64(len(payload))
	httpReq.Header = make(http.Header)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+jwt)
	httpReq.Header.Set("X-Mimo-Source", "mimocode-cli-free")
	httpReq.Header.Set("User-Agent", mimoUserAgent(a.clientIDValue()))
	httpReq.Header.Set("x-session-affinity", a.sessionID())
	if req.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	} else {
		httpReq.Header.Set("Accept", "application/json")
	}
	return httpReq, nil
}

func (a *MimoAdapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	return a.Chat.ParseStream(ctx, body)
}

func (a *MimoAdapter) ParseUnary(ctx context.Context, body []byte) ([]types.AdapterEvent, error) {
	return a.Chat.ParseUnary(ctx, body)
}

func InjectMimoSystemMarker(body map[string]any) map[string]any {
	messages, ok := body["messages"].([]any)
	if !ok {
		// json.Marshal on []map values followed by json.Unmarshal always yields []any,
		// while direct callers may provide []map[string]any.
		if typed, typedOK := body["messages"].([]map[string]any); typedOK {
			messages = make([]any, len(typed))
			for i := range typed {
				messages[i] = typed[i]
			}
			ok = true
		}
	}
	if !ok {
		return body
	}
	for _, rawMessage := range messages {
		message, _ := rawMessage.(map[string]any)
		if message["role"] == "system" && strings.Contains(stringValue(message["content"]), MimoSystemMarker) {
			return body
		}
	}
	marked := make([]any, 0, len(messages)+1)
	marked = append(marked, map[string]any{"role": "system", "content": MimoSystemMarker})
	marked = append(marked, messages...)
	copyBody := make(map[string]any, len(body))
	for key, value := range body {
		copyBody[key] = value
	}
	copyBody["messages"] = marked
	return copyBody
}

func (a *MimoAdapter) getJWT(ctx context.Context) (string, error) {
	for {
		a.mu.Lock()
		if a.jwt != "" && time.Now().Before(a.jwtExpires.Add(-mimoExpiryBuffer)) {
			jwt := a.jwt
			a.mu.Unlock()
			return jwt, nil
		}
		if wait := a.jwtInflight; wait != nil {
			a.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		a.jwtInflight = make(chan struct{})
		wait := a.jwtInflight
		a.mu.Unlock()

		jwt, expires, err := a.fetchJWT(ctx)
		a.mu.Lock()
		if err == nil {
			a.jwt = jwt
			a.jwtExpires = expires
		}
		a.jwtErr = err
		close(wait)
		a.jwtInflight = nil
		a.mu.Unlock()
		return jwt, err
	}
}

func (a *MimoAdapter) fetchJWT(ctx context.Context) (string, time.Time, error) {
	bootstrapURL := a.BootstrapURL
	if bootstrapURL == "" {
		bootstrapURL = MimoBootstrapURL
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	payload, _ := json.Marshal(map[string]string{"client": a.clientIDValue()})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, bootstrapURL, bytes.NewReader(payload))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("build MiMo bootstrap request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", mimoUserAgent(a.clientIDValue()))
	response, err := a.httpClient().Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("MiMo bootstrap failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		drainAndClose(response.Body)
		return "", time.Time{}, fmt.Errorf("MiMo bootstrap failed: %d", response.StatusCode)
	}
	body, err := ReadBodyBounded(ctx, response.Body, 1<<20)
	if err != nil {
		return "", time.Time{}, err
	}
	var result struct {
		JWT string `json:"jwt"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.JWT == "" {
		return "", time.Time{}, fmt.Errorf("MiMo bootstrap returned no JWT")
	}
	return result.JWT, jwtExpiry(result.JWT), nil
}

func (a *MimoAdapter) ResetJWT() {
	a.mu.Lock()
	a.jwt = ""
	a.jwtExpires = time.Time{}
	a.jwtErr = nil
	a.mu.Unlock()
}

func (a *MimoAdapter) clientIDValue() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.clientID != "" {
		return a.clientID
	}
	dir := a.ConfigDir
	if dir == "" {
		dir = os.Getenv("OPENCODEX_HOME")
		if dir == "" {
			home, _ := os.UserHomeDir()
			dir = filepath.Join(home, ".opencodex")
		}
	}
	path := filepath.Join(dir, "mimo-client-id")
	if stored, err := os.ReadFile(path); err == nil && validUUID(strings.TrimSpace(string(stored))) {
		a.clientID = strings.TrimSpace(string(stored))
		return a.clientID
	}
	a.clientID = randomUUID()
	if os.MkdirAll(dir, 0o700) == nil {
		_ = os.WriteFile(path, []byte(a.clientID+"\n"), 0o600)
	}
	return a.clientID
}

func (a *MimoAdapter) sessionID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.SessionID == "" {
		a.SessionID = "ses_" + randomHex(12)
	}
	return a.SessionID
}

func (a *MimoAdapter) httpClient() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return NewHTTPClient(0)
}

func jwtExpiry(token string) time.Time {
	parts := strings.Split(token, ".")
	if len(parts) >= 2 {
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err == nil {
			var claims struct {
				Exp int64 `json:"exp"`
			}
			if json.Unmarshal(payload, &claims) == nil && claims.Exp > 0 {
				return time.Unix(claims.Exp, 0)
			}
		}
	}
	return time.Now().Add(mimoFallbackTTL)
}

func mimoUserAgent(seed string) string {
	if len(mimoUserAgents) == 0 {
		return "opencodex"
	}
	var sum byte
	for i := range seed {
		sum += seed[i]
	}
	return mimoUserAgents[int(sum)%len(mimoUserAgents)]
}

func randomUUID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano()&0xffffffffffff)
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	hexValue := hex.EncodeToString(raw)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexValue[:8], hexValue[8:12], hexValue[12:16], hexValue[16:20], hexValue[20:])
}

func randomHex(bytesCount int) string {
	raw := make([]byte, bytesCount)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}

func validUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	_, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	return err == nil
}

func urlForRequest(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid MiMo chat URL %q", rawURL)
	}
	return parsed, nil
}
