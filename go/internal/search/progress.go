package search

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
)

var ErrProgressInactivity = errors.New("web-search upstream made no byte progress")

type ProgressOptions struct {
	HeartbeatInterval time.Duration
	InactivityTimeout time.Duration
	BufferSize        int
}

type progressChunk struct {
	data []byte
	err  error
}

// ProgressStream preserves upstream bytes, injects SSE comments during quiet
// but permitted periods, and fails when actual upstream bytes stop for too long.
type ProgressStream struct {
	source    io.ReadCloser
	ctx       context.Context
	cancel    context.CancelFunc
	chunks    chan progressChunk
	stall     chan struct{}
	watcher   *protocol.StallWatcher
	heartbeat time.Duration
	pending   []byte
	once      sync.Once
}

func NewProgressStream(ctx context.Context, source io.ReadCloser, options ProgressOptions) *ProgressStream {
	if options.HeartbeatInterval <= 0 {
		options.HeartbeatInterval = 15 * time.Second
	}
	if options.InactivityTimeout <= 0 {
		options.InactivityTimeout = 200 * time.Second
	}
	if options.BufferSize <= 0 {
		options.BufferSize = 32 << 10
	}
	streamCtx, cancel := context.WithCancel(ctx)
	stream := &ProgressStream{
		source: source, ctx: streamCtx, cancel: cancel, chunks: make(chan progressChunk, 1),
		stall: make(chan struct{}), heartbeat: options.HeartbeatInterval,
	}
	stream.watcher = protocol.NewStallWatcher(options.InactivityTimeout, func() { close(stream.stall) })
	go stream.pump(options.BufferSize)
	return stream
}

func (s *ProgressStream) pump(size int) {
	defer close(s.chunks)
	buffer := make([]byte, size)
	for {
		n, err := s.source.Read(buffer)
		if n > 0 {
			s.watcher.Activity()
			chunk := append([]byte(nil), buffer[:n]...)
			select {
			case s.chunks <- progressChunk{data: chunk}:
			case <-s.ctx.Done():
				return
			}
		}
		if err != nil {
			select {
			case s.chunks <- progressChunk{err: err}:
			case <-s.ctx.Done():
			}
			return
		}
	}
}

func (s *ProgressStream) Read(destination []byte) (int, error) {
	if len(destination) == 0 {
		return 0, nil
	}
	if len(s.pending) > 0 {
		return s.copyPending(destination), nil
	}
	timer := time.NewTimer(s.heartbeat)
	defer timer.Stop()
	select {
	case <-s.ctx.Done():
		return 0, s.ctx.Err()
	case <-s.stall:
		return 0, fmt.Errorf("%w after inactivity timeout", ErrProgressInactivity)
	case <-timer.C:
		s.pending = []byte(": opencodex web-search progress\n\n")
		return s.copyPending(destination), nil
	case chunk, ok := <-s.chunks:
		if !ok {
			return 0, io.EOF
		}
		if len(chunk.data) > 0 {
			s.pending = chunk.data
			return s.copyPending(destination), nil
		}
		return 0, chunk.err
	}
}

func (s *ProgressStream) copyPending(destination []byte) int {
	n := copy(destination, s.pending)
	s.pending = s.pending[n:]
	return n
}

func (s *ProgressStream) Close() error {
	var err error
	s.once.Do(func() {
		s.cancel()
		s.watcher.Stop()
		err = s.source.Close()
	})
	return err
}
