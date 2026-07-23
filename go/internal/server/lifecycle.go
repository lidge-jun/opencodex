package server

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Lifecycle tracks active long-lived requests and coordinates graceful drain.
type Lifecycle struct {
	mu       sync.Mutex
	active   map[uint64]context.CancelFunc
	next     uint64
	draining bool
	changed  chan struct{}
}

func NewLifecycle() *Lifecycle {
	return &Lifecycle{active: make(map[uint64]context.CancelFunc), changed: make(chan struct{}, 1)}
}
func (l *Lifecycle) IsDraining() bool { l.mu.Lock(); defer l.mu.Unlock(); return l.draining }
func (l *Lifecycle) Active() int      { l.mu.Lock(); defer l.mu.Unlock(); return len(l.active) }

func (l *Lifecycle) Track(parent context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	l.mu.Lock()
	id := l.next
	l.next++
	l.active[id] = cancel
	l.mu.Unlock()
	once := sync.Once{}
	return ctx, func() {
		once.Do(func() {
			cancel()
			l.mu.Lock()
			delete(l.active, id)
			l.mu.Unlock()
			select {
			case l.changed <- struct{}{}:
			default:
			}
		})
	}
}

func (l *Lifecycle) Drain(ctx context.Context) error {
	l.mu.Lock()
	l.draining = true
	l.mu.Unlock()
	for {
		l.mu.Lock()
		count := len(l.active)
		l.mu.Unlock()
		if count == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			l.abortAll()
			return ctx.Err()
		case <-l.changed:
		}
	}
}

func (l *Lifecycle) abortAll() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, cancel := range l.active {
		cancel()
		delete(l.active, id)
	}
}

// ServeUntilSignal starts server and drains it after SIGTERM or SIGINT.
func ServeUntilSignal(server *http.Server, lifecycle *Lifecycle, drainTimeout time.Duration) error {
	if lifecycle == nil {
		lifecycle = NewLifecycle()
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	errCh := make(chan error, 1)
	go func() { errCh <- server.ListenAndServe() }()
	select {
	case err := <-errCh:
		return err
	case <-signals:
		ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
		defer cancel()
		_ = lifecycle.Drain(ctx)
		return server.Shutdown(ctx)
	}
}
