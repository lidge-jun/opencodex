package oauth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultCallbackPath    = "/callback"
	defaultCallbackTimeout = 5 * time.Minute
)

type CallbackOptions struct {
	PreferredPort    int
	Path             string
	CallbackHostname string
	BindHostname     string
	RedirectURI      string
	Timeout          time.Duration
}

type CallbackResult struct {
	Code  string
	State string
}

type CallbackInputKind string

const (
	CallbackInputURL   CallbackInputKind = "url"
	CallbackInputQuery CallbackInputKind = "query"
	CallbackInputRaw   CallbackInputKind = "raw"
)

type ParsedCallbackInput struct {
	Kind  CallbackInputKind
	Code  string
	State string
}

type ManualCodeFunc func(ctx context.Context, expectedState string) (string, error)

type callbackOutcome struct {
	result CallbackResult
	err    error
}

// CallbackServer owns the IPv4/IPv6 loopback listeners for one OAuth attempt.
type CallbackServer struct {
	State       string
	RedirectURI string
	Timeout     time.Duration

	path       string
	outcome    chan callbackOutcome
	servers    []*http.Server
	listeners  []net.Listener
	closeOnce  sync.Once
	resultOnce sync.Once
}

func StartCallbackServer(options CallbackOptions) (*CallbackServer, error) {
	options = normalizeCallbackOptions(options)
	state, err := randomState()
	if err != nil {
		return nil, err
	}
	session := &CallbackServer{
		State:   state,
		Timeout: options.Timeout,
		path:    options.Path,
		outcome: make(chan callbackOutcome, 1),
	}

	port := options.PreferredPort
	if err := session.listen(options, port); err != nil {
		session.Close()
		if options.RedirectURI != "" {
			return nil, fmt.Errorf("OAuth callback port %d unavailable: %w", port, err)
		}
		session = &CallbackServer{State: state, Timeout: options.Timeout, path: options.Path, outcome: make(chan callbackOutcome, 1)}
		if err := session.listen(options, 0); err != nil {
			session.Close()
			return nil, fmt.Errorf("start OAuth callback listener: %w", err)
		}
	}
	actualPort := session.listeners[0].Addr().(*net.TCPAddr).Port
	if options.RedirectURI != "" {
		session.RedirectURI = options.RedirectURI
	} else {
		session.RedirectURI = fmt.Sprintf("http://%s:%d%s", options.CallbackHostname, actualPort, options.Path)
	}
	return session, nil
}

func normalizeCallbackOptions(options CallbackOptions) CallbackOptions {
	if options.Path == "" {
		options.Path = defaultCallbackPath
	}
	if !strings.HasPrefix(options.Path, "/") {
		options.Path = "/" + options.Path
	}
	if options.CallbackHostname == "" {
		options.CallbackHostname = "localhost"
	}
	if options.BindHostname == "" {
		options.BindHostname = "127.0.0.1"
	}
	if options.Timeout <= 0 {
		options.Timeout = defaultCallbackTimeout
	}
	return options
}

func randomState() (string, error) {
	state := make([]byte, 16)
	if _, err := rand.Read(state); err != nil {
		return "", fmt.Errorf("generate OAuth state: %w", err)
	}
	return hex.EncodeToString(state), nil
}

func (s *CallbackServer) listen(options CallbackOptions, port int) error {
	hosts := loopbackBindHostnames(options.CallbackHostname, options.BindHostname)
	primary, err := listenLoopback(hosts[0], port)
	if err != nil {
		return err
	}
	s.listeners = append(s.listeners, primary)
	actualPort := primary.Addr().(*net.TCPAddr).Port
	for _, host := range hosts[1:] {
		extra, extraErr := listenLoopback(host, actualPort)
		if extraErr != nil {
			if errors.Is(extraErr, syscall.EADDRINUSE) {
				return extraErr
			}
			continue
		}
		s.listeners = append(s.listeners, extra)
	}
	for _, listener := range s.listeners {
		server := &http.Server{
			Handler:           http.HandlerFunc(s.handleCallback),
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       10 * time.Second,
		}
		s.servers = append(s.servers, server)
		go func(srv *http.Server, ln net.Listener) {
			_ = srv.Serve(ln)
		}(server, listener)
	}
	return nil
}

func loopbackBindHostnames(callbackHostname, bindHostname string) []string {
	if strings.EqualFold(strings.TrimSpace(callbackHostname), "localhost") && bindHostname == "127.0.0.1" {
		return []string{"127.0.0.1", "::1"}
	}
	return []string{bindHostname}
}

func listenLoopback(host string, port int) (net.Listener, error) {
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("OAuth callback bind host %q is not loopback", host)
	}
	network := "tcp4"
	if ip.To4() == nil {
		network = "tcp6"
	}
	return net.Listen(network, net.JoinHostPort(host, fmt.Sprint(port)))
}

func (s *CallbackServer) handleCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Path != s.path {
		http.NotFound(w, r)
		return
	}
	if len(r.URL.RawQuery) > 16<<10 {
		http.Error(w, "callback query too large", http.StatusRequestURITooLong)
		return
	}
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	oauthError := r.URL.Query().Get("error")
	errorDescription := r.URL.Query().Get("error_description")
	stateMatches := constantTimeStateEqual(state, s.State)

	status := http.StatusBadRequest
	message := "Missing authorization code"
	consume := false
	var outcome callbackOutcome
	switch {
	case oauthError != "":
		if errorDescription == "" {
			errorDescription = oauthError
		}
		message = "Authorization failed: " + errorDescription
		consume = stateMatches
		if consume {
			status = http.StatusInternalServerError
			outcome.err = errors.New(message)
		}
	case code == "":
	case !stateMatches:
		message = "State mismatch - possible CSRF attack"
	case len(code) > 8192:
		message = "Authorization code is too large"
	case stateMatches:
		status = http.StatusOK
		message = "Login complete. You can close this tab."
		consume = true
		outcome.result = CallbackResult{Code: code, State: state}
	}
	if consume {
		s.resultOnce.Do(func() { s.outcome <- outcome })
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, "<!doctype html><html><body><p>%s</p></body></html>", html.EscapeString(message))
}

func constantTimeStateEqual(actual, expected string) bool {
	if len(actual) != len(expected) || expected == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}

// Wait races the browser callback against optional manual input and timeout.
// URL/query-shaped manual input must include the expected state; a raw code is
// accepted because it belongs to this already-created PKCE session.
func (s *CallbackServer) Wait(ctx context.Context, manual ManualCodeFunc) (CallbackResult, error) {
	waitCtx, cancel := context.WithTimeout(ctx, s.Timeout)
	defer cancel()
	for {
		manualResult := make(chan callbackOutcome, 1)
		if manual != nil {
			go readManualCode(waitCtx, manual, s.State, manualResult)
		}
		select {
		case outcome := <-s.outcome:
			return outcome.result, outcome.err
		case outcome := <-manualResult:
			if outcome.err == nil && outcome.result.Code != "" {
				return outcome.result, nil
			}
		case <-waitCtx.Done():
			return CallbackResult{}, fmt.Errorf("OAuth callback cancelled: %w", waitCtx.Err())
		}
	}
}

func readManualCode(ctx context.Context, manual ManualCodeFunc, expectedState string, result chan<- callbackOutcome) {
	input, err := manual(ctx, expectedState)
	if err != nil {
		result <- callbackOutcome{err: err}
		return
	}
	parsed := ParseCallbackInput(input)
	if parsed.Code == "" {
		result <- callbackOutcome{err: errors.New("manual input has no authorization code")}
		return
	}
	if parsed.Kind != CallbackInputRaw && !constantTimeStateEqual(parsed.State, expectedState) {
		result <- callbackOutcome{err: errors.New("manual callback state mismatch")}
		return
	}
	state := parsed.State
	if state == "" {
		state = expectedState
	}
	result <- callbackOutcome{result: CallbackResult{Code: parsed.Code, State: state}}
}

func ParseCallbackInput(input string) ParsedCallbackInput {
	value := strings.TrimSpace(input)
	if value == "" {
		return ParsedCallbackInput{Kind: CallbackInputRaw}
	}
	if parsed, err := url.Parse(value); err == nil && parsed.IsAbs() {
		return ParsedCallbackInput{Kind: CallbackInputURL, Code: parsed.Query().Get("code"), State: parsed.Query().Get("state")}
	}
	if strings.Contains(value, "code=") {
		params, _ := url.ParseQuery(strings.TrimLeft(value, "?#"))
		return ParsedCallbackInput{Kind: CallbackInputQuery, Code: params.Get("code"), State: params.Get("state")}
	}
	parts := strings.SplitN(value, "#", 2)
	parsed := ParsedCallbackInput{Kind: CallbackInputRaw, Code: parts[0]}
	if len(parts) == 2 {
		parsed.State = parts[1]
	}
	return parsed
}

func (s *CallbackServer) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		for _, server := range s.servers {
			if err := server.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) && closeErr == nil {
				closeErr = err
			}
		}
		for _, listener := range s.listeners {
			_ = listener.Close()
		}
	})
	return closeErr
}
