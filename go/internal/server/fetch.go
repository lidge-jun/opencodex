package server

import (
	"context"
	"net"
	"net/http"
	"time"
)

type FetchTimeouts struct {
	Connect        time.Duration
	TLSHandshake   time.Duration
	ResponseHeader time.Duration
	Overall        time.Duration
}

// NewProviderClient constructs a client with separate connection and response-header deadlines.
func NewProviderClient(timeouts FetchTimeouts) *http.Client {
	if timeouts.Connect <= 0 {
		timeouts.Connect = 10 * time.Second
	}
	if timeouts.TLSHandshake <= 0 {
		timeouts.TLSHandshake = 10 * time.Second
	}
	if timeouts.ResponseHeader <= 0 {
		timeouts.ResponseHeader = 30 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: timeouts.Connect, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = timeouts.TLSHandshake
	transport.ResponseHeaderTimeout = timeouts.ResponseHeader
	return &http.Client{Transport: transport, Timeout: timeouts.Overall}
}

// FetchProvider performs one outbound request with an optional overall deadline.
func FetchProvider(ctx context.Context, client *http.Client, request *http.Request, overall time.Duration) (*http.Response, error) {
	if client == nil {
		client = NewProviderClient(FetchTimeouts{})
	}
	if overall > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, overall)
		defer cancel()
	}
	return client.Do(request.Clone(ctx))
}
