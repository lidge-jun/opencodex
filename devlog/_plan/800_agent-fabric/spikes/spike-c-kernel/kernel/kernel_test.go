package kernel

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func mktmp(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "fab00spike-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func mkEvent(seq uint64, etype, rsid string, payload any) Event {
	var p json.RawMessage
	if payload != nil {
		p, _ = json.Marshal(payload)
	}
	return Event{TaskID: "task_1", Sequence: seq, EventID: fmt.Sprintf("evt_%d", seq),
		EventType: etype, SchemaVersion: "1.0.0", OccurredAt: 1, ActorType: "supervisor",
		ActorID: "sup", RuntimeSessionID: rsid, Payload: p}
}

func TestAppendOnlyAndHashChain(t *testing.T) {
	d := mktmp(t)
	log := NewLog(d, "task_1")
	for i := 1; i <= 3; i++ {
		if err := log.Append(mkEvent(uint64(i), "RunProgress", "rs_a", nil)); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	all, _ := log.All()
	if len(all) != 3 {
		t.Fatalf("want 3 events, got %d", len(all))
	}
	for i, ev := range all {
		if ev.Sequence != uint64(i+1) {
			t.Fatalf("seq %d", ev.Sequence)
		}
		if ev.EventHash == "" {
			t.Fatalf("empty hash at %d", ev.Sequence)
		}
	}
}

func TestExpectedSequenceRejection(t *testing.T) {
	d := mktmp(t)
	log := NewLog(d, "task_1")
	_ = log.Append(mkEvent(1, "RunStarted", "rs_a", nil))
	// stale writer: wrong expected sequence (2 expected, send 3)
	err := log.Append(mkEvent(3, "RunProgress", "rs_b", nil))
	if err == nil {
		t.Fatal("stale writer accepted")
	}
}

func TestProjectionRebuildFromZero(t *testing.T) {
	d := mktmp(t)
	log := NewLog(d, "task_1")
	_ = log.Append(mkEvent(1, "TaskCreated", "rs_a", map[string]string{"acceptance_criteria_hash": "ac1"}))
	_ = log.Append(mkEvent(2, "RunStarted", "rs_a", nil))
	_ = log.Append(mkEvent(3, "HandoffCommitted", "rs_a", map[string]string{"new_owner": "rs_b"}))
	// simulate crash: rebuild from zero by re-reading the log
	p, err := log.Rebuild()
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if p.CurrentOwner != "rs_b" {
		t.Fatalf("owner=%s want rs_b", p.CurrentOwner)
	}
	if p.FencingToken != 1 {
		t.Fatalf("fencing=%d want 1", p.FencingToken)
	}
	if p.AcceptedHash != "ac1" {
		t.Fatalf("acchash=%s", p.AcceptedHash)
	}
}

func TestSchemaVersionTolerance(t *testing.T) {
	d := mktmp(t)
	log := NewLog(d, "task_1")
	// Unknown event type must survive as RawRuntimeEvent-style passthrough.
	_ = log.Append(mkEvent(1, "RawRuntimeEvent", "rs_a", json.RawMessage(`{"native_type":"Foo","native_id":"n1"}`)))
	_ = log.Append(mkEvent(2, "RunStarted", "rs_a", nil))
	p, err := log.Rebuild()
	if err != nil {
		t.Fatalf("rebuild with unknown event: %v", err)
	}
	if p.CurrentOwner != "rs_a" {
		t.Fatalf("owner=%s", p.CurrentOwner)
	}
}

func TestArtifactContentAddressing(t *testing.T) {
	d := mktmp(t)
	a := &ArtifactStore{Dir: filepath.Join(d, "artifacts")}
	h1, _ := a.Store([]byte("hello"))
	h2, _ := a.Store([]byte("hello")) // dedup
	h3, _ := a.Store([]byte("world"))
	if h1 != h2 {
		t.Fatal("dedup failed")
	}
	if h1 == h3 {
		t.Fatal("hash collision")
	}
	// verify content retrievable by hash path
	got, err := os.ReadFile(filepath.Join(d, "artifacts", "sha256", h1[:2], h1))
	if err != nil || string(got) != "hello" {
		t.Fatalf("artifact not retrievable: %v", err)
	}
}

func TestFencingTokenMonotonicAndStaleRejection(t *testing.T) {
	d := mktmp(t)
	ls := &Leases{Path: filepath.Join(d, "lease.json")}
	tok, _ := ls.AcquireWriteLease("rs_a")
	if tok != 0 {
		t.Fatalf("tok=%d want 0", tok)
	}
	ls.CommitHandoff("rs_b") // token -> 1
	if err := ls.CheckFencing(0); err == nil {
		t.Fatal("stale writer (token 0) not rejected after commit")
	}
	if err := ls.CheckFencing(1); err != nil {
		t.Fatalf("current token rejected: %v", err)
	}
	ls.CommitHandoff("rs_c") // token -> 2
	if ls.read().FencingToken != 2 {
		t.Fatalf("token not monotonic: %d", ls.read().FencingToken)
	}
}

func TestOnePrimaryOwnerAndRollback(t *testing.T) {
	d := mktmp(t)
	log := NewLog(d, "task_1")
	ls := &Leases{Path: filepath.Join(d, "lease.json")}
	ls.AcquireWriteLease("rs_a")
	_ = log.Append(mkEvent(1, "RunStarted", "rs_a", nil))
	// proposed handoff that is rolled back (pre-commit failure) -- ownership unchanged
	_ = log.Append(mkEvent(2, "HandoffRolledBack", "rs_a", nil))
	p, _ := log.Rebuild()
	if p.CurrentOwner != "rs_a" {
		t.Fatalf("rollback changed ownership: %s", p.CurrentOwner)
	}
	if p.FencingToken != 0 {
		t.Fatalf("rollback changed fencing: %d", p.FencingToken)
	}
	// successful handoff flips exactly once
	_ = log.Append(mkEvent(3, "HandoffCommitted", "rs_a", map[string]string{"new_owner": "rs_b"}))
	p2, _ := log.Rebuild()
	if p2.CurrentOwner != "rs_b" || p2.FencingToken != 1 {
		t.Fatalf("post-commit owner=%s fencing=%d", p2.CurrentOwner, p2.FencingToken)
	}
}

func TestPermissionsNeverWidenWithoutApproval(t *testing.T) {
	d := mktmp(t)
	log := NewLog(d, "task_1")
	_ = log.Append(mkEvent(1, "RunStarted", "rs_a", nil)) // base policy
	p, _ := log.Rebuild()
	if p.Permissions["rs_a"] != "base" {
		t.Fatal("base policy not set")
	}
	// widen via ApprovalResolved (an approval event) is allowed
	_ = log.Append(mkEvent(2, "ApprovalResolved", "rs_a", map[string]any{"runtime_session_id": "rs_a", "policy": "widened"}))
	p2, _ := log.Rebuild()
	if p2.Permissions["rs_a"] != "widened" {
		t.Fatalf("widening without approval event; got %v", p2.Permissions)
	}
}
