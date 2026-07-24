package cursor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
)

type ErrorKind string

const (
	ErrorTransport    ErrorKind = "transport"
	ErrorQuota        ErrorKind = "quota"
	ErrorSize         ErrorKind = "size"
	ErrorAuth         ErrorKind = "auth"
	ErrorCancellation ErrorKind = "cancellation"
	ErrorProtocol     ErrorKind = "protocol"
	ErrorUpstream     ErrorKind = "upstream"
)

type CursorError struct {
	Kind       ErrorKind
	StatusCode int
	Retryable  bool
	Err        error
}

func (e *CursorError) Error() string { return fmt.Sprintf("cursor %s error: %v", e.Kind, e.Err) }
func (e *CursorError) Unwrap() error { return e.Err }

func ClassifyError(err error) *CursorError {
	if err == nil {
		return nil
	}
	lower := strings.ToLower(err.Error())
	if errors.Is(err, context.Canceled) || strings.Contains(lower, "stream suspended") || strings.Contains(lower, "nghttp2_cancel") {
		return &CursorError{Kind: ErrorCancellation, StatusCode: 499, Err: err}
	}
	if strings.Contains(lower, "unauthenticated") || strings.Contains(lower, "unauthorized") || strings.Contains(lower, "permission_denied") || strings.Contains(lower, "forbidden") || strings.Contains(lower, "invalid token") || strings.Contains(lower, "expired token") {
		return &CursorError{Kind: ErrorAuth, StatusCode: 401, Err: err}
	}
	if strings.Contains(lower, "resource_exhausted") || strings.Contains(lower, "resource exhausted") {
		if requestTooLarge(lower) {
			return &CursorError{Kind: ErrorSize, StatusCode: 400, Err: err}
		}
		return &CursorError{Kind: ErrorQuota, StatusCode: 429, Err: err}
	}
	if strings.Contains(lower, "rate limit") || strings.Contains(lower, "too many requests") || strings.Contains(lower, "throttl") || strings.Contains(lower, "quota") {
		return &CursorError{Kind: ErrorQuota, StatusCode: 429, Err: err}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.ErrUnexpectedEOF) || isNetworkError(err) || strings.Contains(lower, "goaway") || strings.Contains(lower, "connection reset") || strings.Contains(lower, "econnrefused") || strings.Contains(lower, "unavailable") || strings.Contains(lower, "timed out") || strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline") {
		return &CursorError{Kind: ErrorTransport, StatusCode: 502, Retryable: true, Err: err}
	}
	if strings.Contains(lower, "invalid") || strings.Contains(lower, "malformed") || strings.Contains(lower, "illegal tag") || strings.Contains(lower, "unexpected eof") {
		return &CursorError{Kind: ErrorProtocol, StatusCode: 502, Err: err}
	}
	return &CursorError{Kind: ErrorUpstream, StatusCode: 502, Err: err}
}

func requestTooLarge(lower string) bool {
	for _, cue := range []string{"quota", "rate limit", "too many requests", "throttl"} {
		if strings.Contains(lower, cue) {
			return false
		}
	}
	for _, cue := range []string{"tool catalog too large", "tool registration too large", "too many tools", "message too large", "payload too large", "request too large", "maximum allowed size"} {
		if strings.Contains(lower, cue) {
			return true
		}
	}
	return strings.Contains(lower, "request exceeds") && strings.Contains(lower, "size")
}

func isNetworkError(err error) bool { var netErr net.Error; return errors.As(err, &netErr) }
