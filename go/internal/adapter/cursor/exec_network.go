package cursor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

type FetchRequest struct {
	URL, Method string
	Headers     map[string]string
	Body        []byte
	Timeout     time.Duration
}
type FetchResult struct {
	URL, ContentType string
	StatusCode       int
	Headers          http.Header
	Body             []byte
	Truncated        bool
}

type NetworkExecutor struct {
	Policy ExecPolicy
	Client *http.Client
}

func (e *NetworkExecutor) Fetch(ctx context.Context, req FetchRequest) (FetchResult, error) {
	u, err := e.Policy.CheckURL(req.URL)
	if err != nil {
		return FetchResult{}, err
	}
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost {
		return FetchResult{}, fmt.Errorf("unsupported fetch method %q", method)
	}
	limit := maxOr(e.Policy.Provider.MaxFetchBytes, 4_000_000)
	if int64(len(req.Body)) > limit {
		return FetchResult{}, fmt.Errorf("fetch request body exceeds %d-byte limit", limit)
	}
	if req.Timeout <= 0 {
		req.Timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, req.Timeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(req.Body))
	if err != nil {
		return FetchResult{}, err
	}
	for key, value := range req.Headers {
		httpReq.Header.Set(key, value)
	}
	client := e.Client
	if client == nil {
		client = &http.Client{}
	} else {
		clone := *client
		client = &clone
	}
	previousCheck := client.CheckRedirect
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errorsNew("too many redirects")
		}
		if _, err := e.Policy.CheckURL(next.URL.String()); err != nil {
			return err
		}
		if previousCheck != nil {
			return previousCheck(next, via)
		}
		return nil
	}
	response, err := client.Do(httpReq)
	if err != nil {
		return FetchResult{}, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return FetchResult{}, err
	}
	truncated := int64(len(body)) > limit
	if truncated {
		body = body[:limit]
	}
	return FetchResult{URL: response.Request.URL.String(), ContentType: response.Header.Get("Content-Type"), StatusCode: response.StatusCode, Headers: response.Header.Clone(), Body: body, Truncated: truncated}, nil
}

func errorsNew(message string) error { return fmt.Errorf("%s", message) }
