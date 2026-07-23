package openai

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	DefaultRequestTimeout = 10 * time.Minute
	DefaultBodyLimit      = int64(8 << 20)
	DefaultErrorBodyLimit = int64(64 << 10)
	DefaultReadTimeout    = 30 * time.Second
)

// NewHTTPClient returns a transport suitable for long-lived LLM streams while
// retaining bounded dialing, TLS negotiation, and response-header waits.
func NewHTTPClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = DefaultRequestTimeout
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ResponseHeaderTimeout = 60 * time.Second
	transport.IdleConnTimeout = 90 * time.Second
	return &http.Client{Transport: transport, Timeout: timeout}
}

// InjectHeaders copies non-empty headers without mutating the source map.
func InjectHeaders(dst http.Header, src map[string]string) {
	for key, value := range src {
		if strings.TrimSpace(key) == "" || strings.TrimSpace(value) == "" {
			continue
		}
		dst.Set(key, value)
	}
}

func SetBearerAuth(headers http.Header, token string) {
	if token = strings.TrimSpace(token); token != "" {
		headers.Set("Authorization", "Bearer "+token)
	}
}

// ReadBodyBounded reads an external response under byte, time, and context limits.
func ReadBodyBounded(ctx context.Context, body io.Reader, maxBytes int64) ([]byte, error) {
	if body == nil {
		return nil, fmt.Errorf("read response body: nil body")
	}
	if maxBytes <= 0 {
		maxBytes = DefaultBodyLimit
	}
	data, err := protocol.NewBoundedReader(body, maxBytes, DefaultReadTimeout).ReadAllContext(ctx)
	if err != nil {
		return data, fmt.Errorf("read response body: %w", err)
	}
	return data, nil
}

func decodeSSE(ctx context.Context, body io.ReadCloser) <-chan protocol.SSEEvent {
	out := make(chan protocol.SSEEvent)
	if body == nil {
		close(out)
		return out
	}
	go func() {
		defer close(out)
		defer body.Close()
		decoded := make(chan protocol.SSEEvent)
		decoder := protocol.NewSSEDecoder(decoded)
		copyDone := make(chan struct{})
		go func() {
			_, _ = io.Copy(decoder, body)
			_ = decoder.Close()
			close(decoded)
			close(copyDone)
		}()
		for {
			select {
			case event, ok := <-decoded:
				if !ok {
					<-copyDone
					return
				}
				select {
				case out <- event:
				case <-ctx.Done():
					_ = body.Close()
					for range decoded {
					}
					return
				}
			case <-ctx.Done():
				_ = body.Close()
				for range decoded {
				}
				return
			}
		}
	}()
	return out
}

func sendAdapterEvent(ctx context.Context, out chan<- types.AdapterEvent, event types.AdapterEvent) bool {
	select {
	case out <- event:
		return true
	case <-ctx.Done():
		return false
	}
}
