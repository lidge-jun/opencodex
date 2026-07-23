package openai

import (
	"context"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type TurnQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	queued []types.AdapterEvent
	out    chan types.AdapterEvent
	closed bool
	once   sync.Once
}

func NewTurnQueue(capacity int) *TurnQueue {
	if capacity < 0 {
		capacity = 0
	}
	q := &TurnQueue{queued: make([]types.AdapterEvent, 0, capacity), out: make(chan types.AdapterEvent)}
	q.cond = sync.NewCond(&q.mu)
	go q.deliver()
	return q
}

func NewAdapterEventQueue() *TurnQueue { return NewTurnQueue(16) }

// Push queues an event in call order. It returns false after Close.
func (q *TurnQueue) Push(event types.AdapterEvent) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return false
	}
	q.queued = append(q.queued, event)
	q.cond.Signal()
	return true
}

func (q *TurnQueue) Send(ctx context.Context, event types.AdapterEvent) bool {
	if ctx.Err() != nil {
		return false
	}
	return q.Push(event)
}

func (q *TurnQueue) Close() {
	q.once.Do(func() {
		q.mu.Lock()
		q.closed = true
		q.cond.Broadcast()
		q.mu.Unlock()
	})
}

func (q *TurnQueue) Stream() <-chan types.AdapterEvent { return q.out }

func (q *TurnQueue) deliver() {
	defer close(q.out)
	for {
		q.mu.Lock()
		for len(q.queued) == 0 && !q.closed {
			q.cond.Wait()
		}
		if len(q.queued) == 0 && q.closed {
			q.mu.Unlock()
			return
		}
		event := q.queued[0]
		q.queued = q.queued[1:]
		q.mu.Unlock()
		q.out <- event
	}
}

func (q *TurnQueue) Collect(ctx context.Context) ([]types.AdapterEvent, error) {
	events := make([]types.AdapterEvent, 0)
	for {
		select {
		case event, ok := <-q.out:
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
	replay := make(chan types.AdapterEvent, 1)
	select {
	case event, ok := <-source:
		if !ok {
			close(replay)
			return EventPreflight{Stream: replay, Empty: true}
		}
		replay <- event
		if event.Type == types.EventError {
			close(replay)
			return EventPreflight{Stream: replay, Error: &event}
		}
		go func() {
			defer close(replay)
			for event := range source {
				select {
				case replay <- event:
				case <-ctx.Done():
					return
				}
			}
		}()
		return EventPreflight{Stream: replay}
	case <-ctx.Done():
		close(replay)
		return EventPreflight{Stream: replay, Empty: true}
	}
}
