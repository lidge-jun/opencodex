package sidecar

import (
	"context"
	"sync"
)

// ShutdownTracker is the sidecar's admission fence and in-flight turn registry.
// BeginShutdown prevents new turns but deliberately leaves existing turns alone;
// AbortAll is the bounded-drain fallback that cancels and closes them.
//
// A turn must call Release exactly once. The returned context is cancelled when
// the caller's context is cancelled or when AbortAll is invoked.
type ShutdownTracker struct {
	mu       sync.Mutex
	draining bool
	nextID   uint64
	turns    map[uint64]*shutdownTurn
	done     chan struct{}
}

type shutdownTurn struct {
	cancel       context.CancelFunc
	onAbort      func()
	aborted      bool
	abortInvoked bool
}

type shutdownAbort struct {
	cancel  context.CancelFunc
	onAbort func()
}

// ShutdownLease owns one admitted turn. Release is idempotent. OnAbort installs
// a transport close callback for resources (such as hijacked WebSocket sockets)
// that net/http.Server.Shutdown cannot see.
type ShutdownLease struct {
	tracker *ShutdownTracker
	id      uint64
	ctx     context.Context
	cancel  context.CancelFunc

	once sync.Once
}

// NewShutdownTracker returns an initially open tracker.
func NewShutdownTracker() *ShutdownTracker {
	return &ShutdownTracker{
		turns: make(map[uint64]*shutdownTurn),
		done:  closedShutdownChannel(),
	}
}

func closedShutdownChannel() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

// Register admits one turn unless shutdown has started. The parent context is
// retained as the first cancellation source, while AbortAll is the second.
func (t *ShutdownTracker) Register(parent context.Context) (*ShutdownLease, bool) {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)

	t.mu.Lock()
	defer t.mu.Unlock()
	if t.draining {
		cancel()
		return nil, false
	}
	if len(t.turns) == 0 {
		t.done = make(chan struct{})
	}
	t.nextID++
	id := t.nextID
	t.turns[id] = &shutdownTurn{cancel: cancel}
	return &ShutdownLease{tracker: t, id: id, ctx: ctx, cancel: cancel}, true
}

// Context returns the cancellation-aware context for this turn.
func (l *ShutdownLease) Context() context.Context { return l.ctx }

// OnAbort registers a callback invoked by AbortAll. If the turn was already
// aborted, the callback runs immediately rather than leaving a transport open.
func (l *ShutdownLease) OnAbort(callback func()) {
	if callback == nil {
		return
	}
	l.tracker.mu.Lock()
	turn, active := l.tracker.turns[l.id]
	if active && !turn.aborted {
		turn.onAbort = callback
		l.tracker.mu.Unlock()
		return
	}
	if active && turn.aborted {
		if turn.abortInvoked {
			l.tracker.mu.Unlock()
			return
		}
		turn.onAbort = callback
		turn.abortInvoked = true
		l.tracker.mu.Unlock()
		callback()
		return
	}
	l.tracker.mu.Unlock()
	callback()
}

// Release removes the turn and cancels its derived context. It is safe to call
// from both normal completion and request-cancellation paths.
func (l *ShutdownLease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		l.cancel()
		l.tracker.release(l.id)
	})
}

func (t *ShutdownTracker) release(id uint64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.turns[id]; !ok {
		return
	}
	delete(t.turns, id)
	if len(t.turns) == 0 {
		close(t.done)
	}
}

// BeginShutdown closes the admission fence. It is an irreversible, idempotent
// latch and returns true only for the caller that closed it.
func (t *ShutdownTracker) BeginShutdown() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.draining {
		return false
	}
	t.draining = true
	return true
}

// IsDraining reports whether new turns are rejected.
func (t *ShutdownTracker) IsDraining() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.draining
}

// Active reports the number of admitted turns that have not released.
func (t *ShutdownTracker) Active() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.turns)
}

// Wait blocks until all admitted turns release or ctx expires. BeginShutdown
// need not be called first; this makes the method useful in focused tests.
func (t *ShutdownTracker) Wait(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	t.mu.Lock()
	done := t.done
	t.mu.Unlock()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// AbortAll cancels every active turn and invokes each registered transport
// callback. Callbacks run outside the mutex because closing a socket can cause
// handler code to synchronously release its lease.
func (t *ShutdownTracker) AbortAll() {
	t.mu.Lock()
	turns := make([]shutdownAbort, 0, len(t.turns))
	for _, turn := range t.turns {
		if turn.aborted {
			continue
		}
		turn.aborted = true
		if turn.onAbort != nil {
			turn.abortInvoked = true
		}
		turns = append(turns, shutdownAbort{cancel: turn.cancel, onAbort: turn.onAbort})
	}
	t.mu.Unlock()

	for _, turn := range turns {
		turn.cancel()
		if turn.onAbort != nil {
			turn.onAbort()
		}
	}
}
