package openai

import (
	"context"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type TurnQueue struct {
	mu     sync.Mutex
	queued []types.AdapterEvent
	out    chan types.AdapterEvent
	wake   chan struct{}
	closed bool
	stream sync.Once

	MaxBacklog        int
	OnBacklogExceeded func()
}

func NewTurnQueue(capacity int) *TurnQueue {
	if capacity < 0 {
		capacity = 0
	}
	q := &TurnQueue{
		queued:     make([]types.AdapterEvent, 0, capacity),
		out:        make(chan types.AdapterEvent),
		wake:       make(chan struct{}, 1),
		MaxBacklog: 1024,
	}
	return q
}

func NewAdapterEventQueue() *TurnQueue { return NewTurnQueue(16) }

// Push queues an event in call order. It returns false after Close.
func (q *TurnQueue) Push(event types.AdapterEvent) bool {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return false
	}
	if len(q.queued) == 0 {
		select {
		case q.out <- event:
			q.mu.Unlock()
			return true
		default:
		}
	}
	if len(q.queued) >= q.MaxBacklog {
		callback := q.OnBacklogExceeded
		q.queued = append(q.queued, types.AdapterEvent{
			Type:  types.EventError,
			Error: "consumer backlog exceeded — turn aborted",
		})
		q.closed = true
		q.mu.Unlock()
		if callback != nil {
			callback()
		}
		q.notify()
		return true
	}
	q.queued = append(q.queued, event)
	q.mu.Unlock()
	q.notify()
	return true
}

func (q *TurnQueue) Send(ctx context.Context, event types.AdapterEvent) bool {
	if ctx.Err() != nil {
		return false
	}
	return q.Push(event)
}

func (q *TurnQueue) Close() {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.closed = true
	q.mu.Unlock()
	q.notify()
}

func (q *TurnQueue) Stream() <-chan types.AdapterEvent {
	q.stream.Do(func() { go q.pump() })
	return q.out
}

func (q *TurnQueue) notify() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *TurnQueue) pump() {
	defer close(q.out)
	for {
		q.mu.Lock()
		if len(q.queued) == 0 {
			closed := q.closed
			q.mu.Unlock()
			if closed {
				return
			}
			<-q.wake
			continue
		}
		event := q.queued[0]
		q.mu.Unlock()

		select {
		case q.out <- event:
			q.mu.Lock()
			q.queued = q.queued[1:]
			q.mu.Unlock()
		case <-q.wake:
		}
	}
}

func (q *TurnQueue) Collect(ctx context.Context) ([]types.AdapterEvent, error) {
	events := make([]types.AdapterEvent, 0)
	for {
		select {
		case event, ok := <-q.Stream():
			if !ok {
				return events, nil
			}
			events = append(events, event)
		case <-ctx.Done():
			return events, ctx.Err()
		}
	}
}

type EventPreflight struct {
	Stream <-chan types.AdapterEvent
	Error  *types.AdapterEvent
	Empty  bool
}

func PreflightAdapterEvents(ctx context.Context, source <-chan types.AdapterEvent) EventPreflight {
	buffered := make([]types.AdapterEvent, 0, 1)
	for {
		select {
		case event, ok := <-source:
			if !ok {
				return EventPreflight{Stream: replayAdapterEvents(ctx, buffered, nil), Empty: true}
			}
			buffered = append(buffered, event)
			if event.Type == types.EventHeartbeat {
				continue
			}
			if event.Type == types.EventError {
				return EventPreflight{Stream: replayAdapterEvents(ctx, buffered, nil), Error: &event}
			}
			return EventPreflight{Stream: replayAdapterEvents(ctx, buffered, source)}
		case <-ctx.Done():
			return EventPreflight{Stream: replayAdapterEvents(ctx, buffered, nil), Empty: true}
		}
	}
}

func replayAdapterEvents(ctx context.Context, buffered []types.AdapterEvent, source <-chan types.AdapterEvent) <-chan types.AdapterEvent {
	replay := make(chan types.AdapterEvent, len(buffered))
	go func() {
		defer close(replay)
		for _, event := range buffered {
			select {
			case replay <- event:
			case <-ctx.Done():
				return
			}
		}
		if source == nil {
			return
		}
		for event := range source {
			select {
			case replay <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return replay
}
