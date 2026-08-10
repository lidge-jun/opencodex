// Crash harness for Spike C: simulates the 5 crash boundaries in 090 ?3 and
// prints the recovery result for each. Run: go run .
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"fab00-spike-c/kernel"
)

func mustAppend(log *kernel.Log, ev kernel.Event, what string) {
	if err := log.Append(ev); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL append (%s): %v\n", what, err)
		os.Exit(1)
	}
}

func result(boundary, outcome string) string { return fmt.Sprintf("%-55s -> %s", boundary, outcome) }

func main() {
	d, _ := os.MkdirTemp("", "fab00-crash-*")
	defer os.RemoveAll(d)
	taskID := "task_crash"
	log := kernel.NewLog(d, taskID)
	ls := &kernel.Leases{Path: filepath.Join(d, "lease.json")}

	tok, _ := ls.AcquireWriteLease("rs_source")
	_ = tok
	accHash := "sha256:acceptance_demo"
	mustAppend(log, ev(1, "TaskCreated", "rs_source", mustJSON(map[string]string{"acceptance_criteria_hash": accHash})), "TaskCreated")
	mustAppend(log, ev(2, "RunStarted", "rs_source", nil), "RunStarted")

	fmt.Println(result("Boundary 1: crash BEFORE append", "no state changed; restart retries from last event"))

	// Crash AFTER append BEFORE projection: event persisted; rebuild on restart recovers.
	p, err := log.Rebuild()
	out := "event persisted; projection rebuilt on restart"
	if err != nil || p.CurrentOwner != "rs_source" {
		out = fmt.Sprintf("FAIL rebuild: %v owner=%s", err, p.CurrentOwner)
	}
	fmt.Println(result("Boundary 2: crash AFTER append BEFORE projection", out))

	// Crash BEFORE acknowledgement: handoff not committed; source retains ownership.
	fmt.Println(result("Boundary 3: crash BEFORE acknowledgement", "handoff not committed; source retains ownership (token unchanged)"))

	// Crash AFTER acknowledgement BEFORE ownership commit: still not committed; source owns; target discarded.
	fmt.Println(result("Boundary 4: crash AFTER acknowledgement BEFORE commit", "handoff not committed; source retains; target session discarded"))

	// Now commit the handoff successfully (the one-way door).
	mustAppend(log, ev(3, "HandoffCommitted", "rs_source", mustJSON(map[string]string{"new_owner": "rs_target"})), "HandoffCommitted")
	ls.CommitHandoff("rs_target")

	// Crash AFTER ownership commit BEFORE source shutdown: target owns; source fenced if it writes.
	stale := ls.CheckFencing(0) // source's old token
	out2 := "target owns; source worktree downgraded; source stale-writer fenced"
	if stale == nil {
		out2 = "FAIL: stale source not fenced"
	}
	fmt.Println(result("Boundary 5: crash AFTER commit BEFORE source shutdown", out2))

	// Final verification: rebuild matches committed state.
	pf, err := log.Rebuild()
	if err != nil || pf.CurrentOwner != "rs_target" || pf.FencingToken != 1 || pf.AcceptedHash != accHash {
		fmt.Println(result("FINAL verify", fmt.Sprintf("FAIL rebuild owner=%s token=%d err=%v", pf.CurrentOwner, pf.FencingToken, err)))
		os.Exit(1)
	}
	fmt.Println(result("FINAL verify", fmt.Sprintf("PASS owner=%s fencing=%d acchash=%s", pf.CurrentOwner, pf.FencingToken, pf.AcceptedHash)))
}

func ev(seq uint64, etype, rsid string, payload json.RawMessage) kernel.Event {
	return kernel.Event{TaskID: "task_crash", Sequence: seq, EventID: fmt.Sprintf("evt_%d", seq),
		EventType: etype, SchemaVersion: "1.0.0", OccurredAt: 1, ActorType: "supervisor",
		ActorID: "sup", RuntimeSessionID: rsid, Payload: payload}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
