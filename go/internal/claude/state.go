package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	maxStoredResponses     = 1000
	responseTTL            = time.Hour
	maxStoredResponseBytes = 64 << 20
)

type ProviderState map[string]any
type storedResponse struct {
	CreatedAt time.Time
	Items     []any
	Providers ProviderState
	Size      int
}
type ResponseStateStore struct {
	mu      sync.Mutex
	states  map[string]storedResponse
	bytes   int
	now     func() time.Time
	byteCap int
}

func NewResponseStateStore() *ResponseStateStore {
	return &ResponseStateStore{states: map[string]storedResponse{}, now: time.Now, byteCap: maxStoredResponseBytes}
}

var defaultResponseState = NewResponseStateStore()

func ExpandPreviousResponseInput(body map[string]any) map[string]any {
	return defaultResponseState.Expand(body)
}
func PreviousResponseProviderState(id string) ProviderState {
	return defaultResponseState.ProviderState(id)
}
func RememberResponseState(request map[string]any, response map[string]any, provider ProviderState, force bool) {
	defaultResponseState.Remember(request, response, provider, force)
}

func (s *ResponseStateStore) Expand(body map[string]any) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	id := stringField(body, "previous_response_id")
	previous, ok := s.states[id]
	if !ok {
		return body
	}
	out := cloneMap(body)
	out["input"] = append(append([]any{}, previous.Items...), inputItems(body["input"])...)
	return out
}
func (s *ResponseStateStore) ProviderState(id string) ProviderState {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	state, ok := s.states[id]
	if !ok {
		return nil
	}
	return cloneProvider(state.Providers)
}
func (s *ResponseStateStore) Remember(request, response map[string]any, providers ProviderState, force bool) {
	if request["store"] == false && !force {
		return
	}
	id := stringField(response, "id")
	output, ok := response["output"].([]any)
	if id == "" || !ok {
		return
	}
	if status := stringField(response, "status"); status != "" && status != "completed" {
		return
	}
	items := append(inputItems(request["input"]), output...)
	raw, _ := json.Marshal(items)
	state := storedResponse{CreatedAt: s.now(), Items: items, Providers: cloneProvider(providers), Size: len(raw)}
	if cursor, ok := state.Providers["cursor"].(map[string]any); ok && stringField(cursor, "conversationId") != "" {
		usable := true
		for _, item := range output {
			if m, ok := item.(map[string]any); ok && stringField(m, "type") == "function_call" {
				usable = false
			}
		}
		cursor["checkpointUsable"] = usable
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.states[id]; ok {
		s.bytes -= old.Size
	}
	s.states[id] = state
	s.bytes += state.Size
	s.prune()
}

func (s *ResponseStateStore) Save(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	type diskState struct {
		CreatedAt time.Time     `json:"createdAt"`
		Items     []any         `json:"items"`
		Providers ProviderState `json:"providers,omitempty"`
	}
	entries := map[string]diskState{}
	for id, state := range s.states {
		entries[id] = diskState{state.CreatedAt, state.Items, state.Providers}
	}
	b, err := json.Marshal(map[string]any{"version": 2, "states": entries})
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *ResponseStateStore) Load(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var snapshot struct {
		Version int `json:"version"`
		States  map[string]struct {
			CreatedAt time.Time     `json:"createdAt"`
			Items     []any         `json:"items"`
			Providers ProviderState `json:"providers"`
		} `json:"states"`
	}
	if err = json.Unmarshal(b, &snapshot); err != nil {
		return err
	}
	if snapshot.Version != 2 {
		return fmt.Errorf("unsupported response state version %d", snapshot.Version)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states = map[string]storedResponse{}
	s.bytes = 0
	for id, v := range snapshot.States {
		raw, _ := json.Marshal(v.Items)
		s.states[id] = storedResponse{v.CreatedAt, v.Items, v.Providers, len(raw)}
		s.bytes += len(raw)
	}
	s.prune()
	return nil
}
func (s *ResponseStateStore) prune() {
	now := s.now()
	for id, state := range s.states {
		if now.Sub(state.CreatedAt) > responseTTL {
			delete(s.states, id)
			s.bytes -= state.Size
		}
	}
	for len(s.states) > maxStoredResponses || s.bytes > s.byteCap {
		var oldestID string
		var oldest time.Time
		for id, state := range s.states {
			if oldestID == "" || state.CreatedAt.Before(oldest) {
				oldestID = id
				oldest = state.CreatedAt
			}
		}
		if oldestID == "" || len(s.states) <= 1 {
			break
		}
		s.bytes -= s.states[oldestID].Size
		delete(s.states, oldestID)
	}
}
func inputItems(v any) []any {
	switch x := v.(type) {
	case nil:
		return nil
	case []any:
		return append([]any{}, x...)
	case string:
		return []any{map[string]any{"role": "user", "content": x}}
	default:
		return []any{x}
	}
}
func cloneMap(v map[string]any) map[string]any {
	out := map[string]any{}
	for k, x := range v {
		out[k] = x
	}
	return out
}
func cloneProvider(v ProviderState) ProviderState {
	if v == nil {
		return nil
	}
	raw, _ := json.Marshal(v)
	var out ProviderState
	_ = json.Unmarshal(raw, &out)
	return out
}
