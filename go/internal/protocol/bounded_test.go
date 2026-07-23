package protocol

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBoundedReaderWithinAndOverLimit(t *testing.T) {
	data, err := NewBoundedReader(strings.NewReader("hello"), 5, time.Second).ReadAll()
	if err != nil || string(data) != "hello" {
		t.Fatalf("within limit = %q, %v", data, err)
	}
	data, err = NewBoundedReader(strings.NewReader("abcdef"), 5, time.Second).ReadAll()
	if !errors.Is(err, ErrBodyTooLarge) || string(data) != "abcde" {
		t.Fatalf("over limit = %q, %v", data, err)
	}
}

func TestBoundedReaderTimeout(t *testing.T) {
	r := newBlockingReadCloser()
	start := time.Now()
	data, err := NewBoundedReader(r, 10, 30*time.Millisecond).ReadAll()
	if !errors.Is(err, ErrReadTimeout) || data != nil {
		t.Fatalf("ReadAll() = %q, %v", data, err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("timeout did not return promptly")
	}
}

func TestBoundedReaderCancellation(t *testing.T) {
	r := newBlockingReadCloser()
	ctx, cancel := context.WithCancel(context.Background())
	reader := NewBoundedReader(r, 10, time.Second).WithContext(ctx)
	cancel()
	_, err := reader.ReadAll()
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ReadAll() error = %v", err)
	}
}

type blockingReadCloser struct {
	closed chan struct{}
	once   sync.Once
}

func newBlockingReadCloser() *blockingReadCloser {
	return &blockingReadCloser{closed: make(chan struct{})}
}

func (r *blockingReadCloser) Read([]byte) (int, error) {
	<-r.closed
	return 0, io.EOF
}

func (r *blockingReadCloser) Close() error {
	r.once.Do(func() { close(r.closed) })
	return nil
}
