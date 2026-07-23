package protocol

import (
	"sync"
	"time"
)

// StallWatcher invokes a callback once when no activity occurs within timeout.
type StallWatcher struct {
	mu      sync.Mutex
	timeout time.Duration
	onStall func()
	timer   *time.Timer
	gen     uint64
	done    bool
}

func NewStallWatcher(timeout time.Duration, onStall func()) *StallWatcher {
	sw := &StallWatcher{timeout: timeout, onStall: onStall}
	sw.mu.Lock()
	if timeout > 0 {
		sw.scheduleLocked()
	}
	sw.mu.Unlock()
	return sw
}

// Activity resets the inactivity window.
func (sw *StallWatcher) Activity() {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	if sw.done || sw.timeout <= 0 {
		return
	}
	if sw.timer == nil {
		sw.scheduleLocked()
	} else {
		sw.timer.Stop()
		sw.scheduleLocked()
	}
}

func (sw *StallWatcher) Stop() {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	if sw.done {
		return
	}
	sw.done = true
	if sw.timer != nil {
		sw.timer.Stop()
	}
}

func (sw *StallWatcher) scheduleLocked() {
	sw.gen++
	generation := sw.gen
	sw.timer = time.AfterFunc(sw.timeout, func() { sw.fire(generation) })
}

func (sw *StallWatcher) fire(generation uint64) {
	sw.mu.Lock()
	if sw.done || generation != sw.gen {
		sw.mu.Unlock()
		return
	}
	sw.done = true
	callback := sw.onStall
	sw.mu.Unlock()
	if callback != nil {
		callback()
	}
}
