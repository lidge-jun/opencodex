// Spike C -- disposable task-kernel (stdlib only).
// Demonstrates append-only events, expected-sequence concurrency, hash chain,
// deterministic projection rebuild, schema-versioned events, content-addressed
// artifacts, primary lease + monotonic fencing token, stale-writer rejection,
// and crash-boundary recovery. Storage is a JSONL log + files; production uses
// SQLite (master plan ?9.2) -- the invariants here are storage-independent.
package kernel

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Event is the append-only envelope (see 060 ?1, simplified).
type Event struct {
	TaskID            string          `json:"task_id"`
	Sequence          uint64          `json:"sequence"`
	EventID           string          `json:"event_id"`
	EventType         string          `json:"event_type"`
	SchemaVersion     string          `json:"schema_version"`
	OccurredAt        int64           `json:"occurred_at"`
	ActorType         string          `json:"actor_type"`
	ActorID           string          `json:"actor_id"`
	RuntimeSessionID  string          `json:"runtime_session_id"`
	Payload           json.RawMessage `json:"payload"`
	PreviousEventHash string          `json:"previous_event_hash"`
	EventHash         string          `json:"event_hash,omitempty"` // computed; excluded from its own hash
}

// canonicalBytes is the deterministic encoding used for hashing (sorted keys, no event_hash).
func canonicalBytes(ev Event) ([]byte, error) {
	cp := ev
	cp.EventHash = ""
	b, err := json.Marshal(cp)
	if err != nil {
		return nil, err
	}
	m := map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out strings.Builder
	out.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			out.WriteByte(',')
		}
		kj, _ := json.Marshal(k)
		vj, _ := json.Marshal(m[k])
		out.Write(kj)
		out.WriteByte(':')
		out.Write(vj)
	}
	out.WriteByte('}')
	return []byte(out.String()), nil
}

// HashEvent computes the sha256 of the canonical (hash-excluded) encoding.
func HashEvent(ev Event) (string, error) {
	cb, err := canonicalBytes(ev)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(cb)
	return hex.EncodeToString(sum[:]), nil
}

// Log is an append-only JSONL event log for one task.
type Log struct{ Path string }

func NewLog(dir, taskID string) *Log {
	return &Log{Path: filepath.Join(dir, taskID+".events.jsonl")}
}

func (l *Log) lastEvent() (*Event, error) {
	data, err := os.ReadFile(l.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return nil, nil
	}
	var last Event
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &last); err != nil {
		return nil, err
	}
	return &last, nil
}

// Append appends an event, enforcing expected sequence + hash chain.
// Stale writers (wrong expected sequence) are rejected.
func (l *Log) Append(ev Event) error {
	last, err := l.lastEvent()
	if err != nil {
		return err
	}
	wantSeq := uint64(1)
	prevHash := ""
	if last != nil {
		wantSeq = last.Sequence + 1
		prevHash = last.EventHash
	}
	if ev.Sequence != wantSeq {
		return fmt.Errorf("stale writer: expected sequence %d, got %d", wantSeq, ev.Sequence)
	}
	ev.PreviousEventHash = prevHash
	h, err := HashEvent(ev)
	if err != nil {
		return err
	}
	ev.EventHash = h
	line, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	f, err := os.OpenFile(l.Path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(line)
	return err
}

// All reads all events.
func (l *Log) All() ([]Event, error) {
	data, err := os.ReadFile(l.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []Event
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, nil
}

// Projection is the rebuilt current state.
type Projection struct {
	TaskID       string
	CurrentOwner string // runtime_session_id of primary owner ("" if none)
	FencingToken int
	Workspaces   map[string]string
	AcceptedHash string
	Permissions  map[string]string
	Claims       map[string]string
	Terminal     bool
}

// Rebuild replays the log, verifying the hash chain, and projects current state.
func (l *Log) Rebuild() (*Projection, error) {
	evs, err := l.All()
	if err != nil {
		return nil, err
	}
	p := &Projection{Workspaces: map[string]string{}, Permissions: map[string]string{}, Claims: map[string]string{}}
	prevHash := ""
	for i, ev := range evs {
		if ev.Sequence != uint64(i+1) {
			return nil, fmt.Errorf("sequence gap at %d", i+1)
		}
		if ev.PreviousEventHash != prevHash {
			return nil, fmt.Errorf("hash chain broken at sequence %d", ev.Sequence)
		}
		h, err := HashEvent(ev)
		if err != nil {
			return nil, err
		}
		if h != ev.EventHash {
			return nil, fmt.Errorf("event hash mismatch at sequence %d", ev.Sequence)
		}
		prevHash = ev.EventHash
		l.apply(p, ev)
	}
	return p, nil
}

func (l *Log) apply(p *Projection, ev Event) {
	p.TaskID = ev.TaskID
	switch ev.EventType {
	case "TaskCreated":
		var pl struct{ AcceptanceCriteriaHash string `json:"acceptance_criteria_hash"` }
		_ = json.Unmarshal(ev.Payload, &pl)
		p.AcceptedHash = pl.AcceptanceCriteriaHash
	case "RunStarted":
		p.CurrentOwner = ev.RuntimeSessionID
		p.Permissions[ev.RuntimeSessionID] = "base"
	case "ApprovalResolved":
		var pl struct {
			Policy          string
			RuntimeSessionID string `json:"runtime_session_id"`
		}
		_ = json.Unmarshal(ev.Payload, &pl)
		if pl.RuntimeSessionID == "" {
			pl.RuntimeSessionID = ev.RuntimeSessionID
		}
		p.Permissions[pl.RuntimeSessionID] = pl.Policy
	case "ClaimValidated":
		var pl struct{ ClaimID string `json:"claim_id"` }
		_ = json.Unmarshal(ev.Payload, &pl)
		p.Claims[pl.ClaimID] = "validated"
	case "HandoffCommitted":
		var pl struct{ NewOwner string `json:"new_owner"` }
		_ = json.Unmarshal(ev.Payload, &pl)
		p.CurrentOwner = pl.NewOwner
		p.FencingToken++
	case "HandoffRolledBack":
		// ownership unchanged; fencing token unchanged
	case "TaskCompleted":
		p.Terminal = true
	}
}

// ArtifactStore is content-addressed (sha256).
type ArtifactStore struct{ Dir string }

func (a *ArtifactStore) Store(content []byte) (string, error) {
	sum := sha256.Sum256(content)
	h := hex.EncodeToString(sum[:])
	sub := filepath.Join(a.Dir, "sha256", h[:2], h)
	if err := os.MkdirAll(filepath.Dir(sub), 0o755); err != nil {
		return "", err
	}
	if _, err := os.Stat(sub); err == nil {
		return h, nil // dedup
	}
	return h, os.WriteFile(sub, content, 0o600)
}

// Leases models the per-task fencing token + write lease.
type Leases struct{ Path string }

type leaseState struct {
	FencingToken int    `json:"fencing_token"`
	Owner        string `json:"owner"`
}

func (l *Leases) read() leaseState {
	b, err := os.ReadFile(l.Path)
	if err != nil {
		return leaseState{}
	}
	var s leaseState
	_ = json.Unmarshal(b, &s)
	return s
}

func (l *Leases) atomicWrite(s leaseState) error {
	if err := os.MkdirAll(filepath.Dir(l.Path), 0o755); err != nil {
		return err
	}
	tmp := l.Path + ".tmp"
	b, _ := json.Marshal(s)
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, l.Path)
}

// AcquireWriteLease grants the lease if free/owned; returns the fencing token.
func (l *Leases) AcquireWriteLease(owner string) (int, error) {
	s := l.read()
	if s.Owner != "" && s.Owner != owner {
		return 0, fmt.Errorf("write lease held by %s", s.Owner)
	}
	s.Owner = owner
	l.atomicWrite(s)
	return s.FencingToken, nil
}

// CheckFencing rejects stale writers (token < current).
func (l *Leases) CheckFencing(token int) error {
	s := l.read()
	if token < s.FencingToken {
		return fmt.Errorf("stale writer: token %d < current %d", token, s.FencingToken)
	}
	return nil
}

// CommitHandoff atomically flips owner + increments fencing token (one-way door).
func (l *Leases) CommitHandoff(newOwner string) int {
	s := l.read()
	s.Owner = newOwner
	s.FencingToken++
	l.atomicWrite(s)
	return s.FencingToken
}
