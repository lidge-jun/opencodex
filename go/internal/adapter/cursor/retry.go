package cursor

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"
)

const CursorRetryAttempts = 3

type CommitState interface{ RequestCommitted() bool }

func DoPreCommitRetry[T any](ctx context.Context, operation func(context.Context, int) (T, CommitState, error)) (T, error) {
	var zero T
	for attempt := 0; attempt < CursorRetryAttempts; attempt++ {
		value, state, err := operation(ctx, attempt)
		if err == nil {
			return value, nil
		}
		classified := ClassifyError(err)
		if state == nil || state.RequestCommitted() || classified == nil || !classified.Retryable || attempt == CursorRetryAttempts-1 {
			return zero, err
		}
		delay := 250 * time.Millisecond * time.Duration(1<<attempt)
		if delay > 2*time.Second {
			delay = 2 * time.Second
		}
		delay += time.Duration(rand.Int64N(int64(delay/2 + 1)))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return zero, errors.Join(err, ctx.Err())
		case <-timer.C:
		}
	}
	return zero, errors.New("cursor retry exhausted")
}
