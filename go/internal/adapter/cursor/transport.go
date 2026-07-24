package cursor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	cursorRunPath       = "/agent.v1.AgentService/Run"
	cursorClientVersion = "cli-2026.02.13-41ac335"
)

type InteractionHandler func(context.Context, []byte) ([]byte, error)

type TransportConfig struct {
	BaseURL, Token, ClientVersion, SessionID string
	Headers                                  map[string]string
	Client                                   *http.Client
	FirstFrameTimeout                        time.Duration
	MaxFrameSize                             int
	InteractionHandler                       InteractionHandler
}

type LiveTransport struct {
	config      TransportConfig
	committed   atomic.Bool
	mu          sync.Mutex
	requestBody *io.PipeWriter
}

func NewLiveTransport(config TransportConfig) (*LiveTransport, error) {
	if strings.TrimSpace(config.Token) == "" {
		return nil, fmt.Errorf("Cursor access token is required")
	}
	if config.BaseURL == "" {
		config.BaseURL = "https://api2.cursor.sh"
	}
	parsed, err := url.Parse(config.BaseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid Cursor base URL %q", config.BaseURL)
	}
	if config.Client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.ForceAttemptHTTP2 = true
		config.Client = &http.Client{Transport: transport}
	}
	if config.FirstFrameTimeout <= 0 {
		config.FirstFrameTimeout = 30 * time.Second
	}
	if config.ClientVersion == "" {
		config.ClientVersion = cursorClientVersion
	}
	if config.SessionID == "" {
		config.SessionID = newID()
	}
	return &LiveTransport{config: config}, nil
}

func (t *LiveTransport) RequestCommitted() bool { return t.committed.Load() }

func (t *LiveTransport) SendClient(payload []byte) error {
	frame, err := EncodeFrame(ConnectFrame{Payload: payload})
	if err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.requestBody == nil {
		return errors.New("Cursor stream is not open")
	}
	_, err = t.requestBody.Write(frame)
	return err
}

func (t *LiveTransport) Close() error {
	t.mu.Lock()
	writer := t.requestBody
	t.requestBody = nil
	t.mu.Unlock()
	if writer != nil {
		return writer.Close()
	}
	return nil
}

func (t *LiveTransport) Run(ctx context.Context, run AgentRunRequest, emit func(types.AdapterEvent) error) error {
	t.committed.Store(false)
	payload, err := MarshalAgentClientRun(run)
	if err != nil {
		return err
	}
	reader, writer := io.Pipe()
	t.mu.Lock()
	t.requestBody = writer
	t.mu.Unlock()
	defer t.Close()
	endpoint := strings.TrimRight(t.config.BaseURL, "/") + cursorRunPath
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/connect+proto")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("TE", "trailers")
	req.Header.Set("Authorization", "Bearer "+t.config.Token)
	req.Header.Set("X-Ghost-Mode", "true")
	req.Header.Set("X-Cursor-Client-Version", t.config.ClientVersion)
	req.Header.Set("X-Cursor-Client-Type", "cli")
	req.Header.Set("X-Request-Id", newID())
	req.Header.Set("X-Session-Id", t.config.SessionID)
	for key, value := range t.config.Headers {
		if strings.TrimSpace(key) != "" {
			req.Header.Set(key, value)
		}
	}
	trace := &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		if info.Err == nil {
			t.committed.Store(true)
		}
	}}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
	responseCh := make(chan struct {
		response *http.Response
		err      error
	}, 1)
	go func() {
		response, err := t.config.Client.Do(req)
		responseCh <- struct {
			response *http.Response
			err      error
		}{response, err}
	}()
	if err := t.SendClient(payload); err != nil {
		return fmt.Errorf("write Cursor run request: %w", err)
	}
	var response *http.Response
	select {
	case <-ctx.Done():
		return ctx.Err()
	case result := <-responseCh:
		if result.err != nil {
			return result.err
		}
		response = result.response
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("Cursor HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	parser := NewEventParser()
	frames := 0
	first := true
	for {
		var frame ConnectFrame
		if first {
			result := make(chan struct {
				frame ConnectFrame
				err   error
			}, 1)
			go func() {
				f, err := ReadFrame(response.Body, t.config.MaxFrameSize)
				result <- struct {
					frame ConnectFrame
					err   error
				}{f, err}
			}()
			timer := time.NewTimer(t.config.FirstFrameTimeout)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
				return fmt.Errorf("Cursor transport timed out before first response")
			case got := <-result:
				timer.Stop()
				frame, err = got.frame, got.err
			}
			first = false
		} else {
			frame, err = ReadFrame(response.Body, t.config.MaxFrameSize)
		}
		if err != nil {
			if errors.Is(err, io.EOF) && frames == 0 {
				return io.ErrUnexpectedEOF
			}
			if errors.Is(err, io.EOF) && parser.terminated {
				return nil
			}
			return err
		}
		frames++
		if frame.Compressed() {
			return fmt.Errorf("Cursor compressed Connect frames are unsupported")
		}
		if frame.EndStream() {
			if err := ParseEndStreamTrailer(frame.Payload); err != nil {
				return err
			}
			if parser.terminated {
				return nil
			}
			return fmt.Errorf("Cursor stream ended without terminal event")
		}
		server, err := UnmarshalAgentServerMessage(frame.Payload)
		if err != nil {
			return err
		}
		if server.Kind == ServerInteractionQuery {
			var reply []byte
			if t.config.InteractionHandler != nil {
				reply, err = t.config.InteractionHandler(ctx, server.Payload)
			} else {
				reply, err = marshalEmptyInteractionReply(server.Payload)
			}
			if err != nil {
				return err
			}
			if len(reply) > 0 {
				if err := t.SendClient(reply); err != nil {
					return err
				}
			}
			continue
		}
		if server.Kind == ServerKV {
			reply, err := marshalKVReply(server.Payload, run.Blobs)
			if err != nil {
				return err
			}
			if err := t.SendClient(reply); err != nil {
				return err
			}
			continue
		}
		events, err := parser.Parse(frame.Payload)
		if err != nil {
			return err
		}
		for _, event := range events {
			if err := emit(event); err != nil {
				return err
			}
		}
	}
}
