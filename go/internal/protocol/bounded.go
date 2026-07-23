package protocol

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"sync"
	"time"
)

var (
	ErrBodyTooLarge = errors.New("bounded reader: byte limit exceeded")
	ErrReadTimeout  = errors.New("bounded reader: timeout")
)

// BoundedReader reads a body under byte, time, and cancellation limits.
type BoundedReader struct {
	r        io.Reader
	maxBytes int64
	timeout  time.Duration
	ctx      context.Context
}

func NewBoundedReader(r io.Reader, maxBytes int64, timeout time.Duration) *BoundedReader {
	return &BoundedReader{r: r, maxBytes: maxBytes, timeout: timeout, ctx: context.Background()}
}

// WithContext sets the cancellation context used by ReadAll.
func (br *BoundedReader) WithContext(ctx context.Context) *BoundedReader {
	br.ctx = ctx
	return br
}

// ReadAll reads using the context configured by WithContext.
func (br *BoundedReader) ReadAll() ([]byte, error) {
	return br.ReadAllContext(br.ctx)
}

// ReadAllContext reads until EOF, cancellation, timeout, or one byte beyond the limit.
func (br *BoundedReader) ReadAllContext(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if br.maxBytes < 0 {
		return nil, fmt.Errorf("bounded reader: negative byte limit %d", br.maxBytes)
	}
	readLimit := br.maxBytes + 1
	if br.maxBytes == math.MaxInt64 {
		readLimit = math.MaxInt64
	}

	type result struct {
		data []byte
		err  error
	}
	results := make(chan result, 1)
	var closeOnce sync.Once
	closeReader := func() {
		if closer, ok := br.r.(io.Closer); ok {
			closeOnce.Do(func() { _ = closer.Close() })
		}
	}
	go func() {
		data, err := io.ReadAll(io.LimitReader(br.r, readLimit))
		results <- result{data: data, err: err}
	}()

	var timeout <-chan time.Time
	var timer *time.Timer
	if br.timeout > 0 {
		timer = time.NewTimer(br.timeout)
		timeout = timer.C
		defer timer.Stop()
	}

	select {
	case got := <-results:
		if int64(len(got.data)) > br.maxBytes {
			return got.data[:br.maxBytes], ErrBodyTooLarge
		}
		return got.data, got.err
	case <-ctx.Done():
		closeReader()
		return nil, ctx.Err()
	case <-timeout:
		closeReader()
		return nil, ErrReadTimeout
	}
}
