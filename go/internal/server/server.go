package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/chat"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type AdapterResolver func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error)

type Config struct {
	Registry          types.Registry
	Combos            *combos.Resolver
	Auth              types.AuthProvider
	ResolveAdapter    AdapterResolver
	Client            *http.Client
	Token             string
	AllowedOrigins    []string
	Logger            *slog.Logger
	Lifecycle         *Lifecycle
	Management        types.ManagementRouter
	ChatHandler       types.RouteHandler
	MessagesHandler   types.RouteHandler
	CompactHandler    types.RouteHandler
	UsageRecorder     types.UsageRecorder
	RequestLogs       *management.RequestLog
	ManagementConfig  *appconfig.Config
	ConfigPath        string
	DebugLog          *usage.DebugLog
	OAuthManagement   management.OAuthBackend
	StorageHome       string
	Stop              func()
	Version           string
	EffortCap         string
	SubagentEffortCap string
}

type Server struct {
	config    Config
	lifecycle *Lifecycle
	handler   http.Handler
	recorder  types.UsageRecorder
	sequence  atomic.Uint64
}

func New(config Config) *Server {
	if config.Client == nil {
		config.Client = NewProviderClient(FetchTimeouts{Overall: 10 * time.Minute})
	}
	if config.Lifecycle == nil {
		config.Lifecycle = NewLifecycle()
	}
	handlerConfig := chat.HandlerConfig{Registry: config.Registry, Auth: config.Auth, ResolveAdapter: chat.AdapterResolver(config.ResolveAdapter), Client: config.Client}
	if config.ChatHandler == nil {
		config.ChatHandler = chat.NewHandler(handlerConfig)
	}
	if config.MessagesHandler == nil {
		config.MessagesHandler = chat.NewMessagesHandler(handlerConfig)
	}
	if config.CompactHandler == nil {
		config.CompactHandler = chat.NewCompactHandler(handlerConfig)
	}
	requestLogs := config.RequestLogs
	if requestLogs == nil {
		requestLogs = management.NewRequestLog(200)
	}
	recorder := config.UsageRecorder
	if log, ok := recorder.(*usage.Log); ok {
		requestLogs.SetUsageLog(log)
		recorder = requestLogs
	} else if recorder == nil {
		recorder = requestLogs
	} else {
		recorder = fanoutRecorder{requestLog: requestLogs, recorder: recorder}
	}
	s := &Server{config: config, lifecycle: config.Lifecycle, recorder: recorder}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/responses", s.handleResponses)
	mux.HandleFunc("POST /v1/responses/compact", s.delegate(config.CompactHandler))
	mux.HandleFunc("POST /v1/chat/completions", s.delegate(config.ChatHandler))
	mux.HandleFunc("POST /v1/messages", s.delegate(config.MessagesHandler))
	liveness := NewLiveness(config.Version)
	mux.Handle("GET /health", liveness)
	mux.Handle("GET /healthz", liveness)
	mux.Handle("GET /v1/responses/ws", WebSocketBridge(http.HandlerFunc(s.handleResponses)))
	managementRouter := config.Management
	if managementRouter == nil {
		usageLog, _ := config.UsageRecorder.(*usage.Log)
		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, OAuth: config.OAuthManagement, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop})
		if err == nil {
			managementRouter = api
		} else if config.Logger != nil {
			config.Logger.Error("management_api", "error", err)
		}
	}
	if managementRouter != nil {
		managementRouter.Register(mux)
	}
	mux.HandleFunc("/api/", managementStub)
	mux.Handle("/", StaticHandler())
	s.handler = Middleware(decompressionMiddleware(mux), MiddlewareConfig{Token: config.Token, AllowedOrigins: config.AllowedOrigins, Logger: config.Logger})
	return s
}

type fanoutRecorder struct {
	requestLog *management.RequestLog
	recorder   types.UsageRecorder
}

func (r fanoutRecorder) Record(ctx context.Context, record *types.UsageRecord) error {
	if err := r.requestLog.Record(ctx, record); err != nil {
		return err
	}
	return r.recorder.Record(ctx, record)
}

func (s *Server) Handler() http.Handler { return s.handler }
func (s *Server) Lifecycle() *Lifecycle { return s.lifecycle }

func (s *Server) HTTPServer(address string) *http.Server {
	return &http.Server{Addr: address, Handler: s.handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 0, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 1 << 20}
}

func (s *Server) delegate(handler types.RouteHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if handler == nil {
			writeJSONError(w, http.StatusNotImplemented, "endpoint_not_configured", "endpoint handler is not configured")
			return
		}
		handler.Handle(w, r)
	}
}

func (s *Server) handleResponses(w http.ResponseWriter, r *http.Request) {
	if s.lifecycle.IsDraining() {
		writeJSONError(w, http.StatusServiceUnavailable, "server_draining", "server is draining")
		return
	}
	if s.config.Registry == nil || s.config.ResolveAdapter == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "routing integration is not configured")
		return
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	var body struct {
		Model              string `json:"model"`
		Stream             bool   `json:"stream"`
		PreviousResponseID string `json:"previous_response_id"`
		Reasoning          struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || strings.TrimSpace(body.Model) == "" {
		writeJSONError(w, http.StatusBadRequest, "invalid_request", "a valid JSON body with model is required")
		return
	}
	requestedModel := body.Model
	normalized := &types.NormalizedRequest{ModelID: body.Model, PreviousResponseID: body.PreviousResponseID, Stream: body.Stream, RawBody: raw, Options: types.RequestOptions{Reasoning: body.Reasoning.Effort}}
	modelRouter := ModelRouter{Registry: s.config.Registry, Combos: s.config.Combos}
	resolved, comboPick, err := modelRouter.ResolveRequest(normalized)
	if err != nil {
		var unavailable *combos.NoAvailableTargetsError
		if errors.As(err, &unavailable) {
			writeJSONError(w, http.StatusServiceUnavailable, "combo_unavailable", err.Error())
			return
		}
		writeJSONError(w, http.StatusBadRequest, "model_not_found", err.Error())
		return
	}
	raw = normalized.RawBody
	body.Reasoning.Effort = normalized.Options.Reasoning
	effort, keepEffort := EnforceEffort(body.Reasoning.Effort, s.config.EffortCap, s.config.SubagentEffortCap, IsThreadSpawnRequest(r.Header), modelRouter.SupportedEfforts(resolved))
	if effort != normalized.Options.Reasoning || !keepEffort {
		var mutable map[string]any
		if json.Unmarshal(raw, &mutable) == nil {
			if keepEffort {
				reasoning, _ := mutable["reasoning"].(map[string]any)
				if reasoning == nil {
					reasoning = make(map[string]any)
					mutable["reasoning"] = reasoning
				}
				reasoning["effort"] = effort
			} else if reasoning, ok := mutable["reasoning"].(map[string]any); ok {
				delete(reasoning, "effort")
			}
			raw, _ = json.Marshal(mutable)
			body.Reasoning.Effort = effort
		}
	}
	normalized.RawBody = raw
	normalized.Options.Reasoning = body.Reasoning.Effort
	requestStarted := time.Now()
	trackedCtx, done := s.lifecycle.Track(r.Context())
	defer done()
	streamCtx, cancelStream := context.WithCancelCause(trackedCtx)
	defer cancelStream(nil)
	var adapter types.Adapter
	var response *http.Response
	var resolvedAuth *types.AuthContext
	for {
		var auth *types.AuthContext
		if s.config.Auth != nil {
			auth, err = s.config.Auth.ResolveAuth(streamCtx, resolved.Provider, r.Header.Get("thread-id"))
			if err != nil {
				if comboPick != nil {
					next, nextErr := s.config.Combos.Next(normalized, comboPick, http.StatusUnauthorized, "invalid_api_key", err.Error(), "")
					if nextErr == nil {
						comboPick, resolved = next, next.Resolved
						continue
					}
				}
				writeJSONError(w, http.StatusUnauthorized, "authentication_error", err.Error())
				return
			}
		}
		transport, transportErr := s.config.Registry.ResolveTransport(resolved.Provider, auth)
		if transportErr != nil {
			writeJSONError(w, http.StatusBadGateway, "transport_error", transportErr.Error())
			return
		}
		adapter, err = s.config.ResolveAdapter(resolved, transport, auth, r.Header.Clone())
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "adapter_error", err.Error())
			return
		}
		upstreamRequest, buildErr := adapter.BuildRequest(streamCtx, normalized)
		if buildErr != nil {
			writeJSONError(w, http.StatusBadRequest, "request_build_error", buildErr.Error())
			return
		}
		if auth != nil {
			for name, value := range auth.Headers {
				upstreamRequest.Header.Set(name, value)
			}
		}
		response, err = FetchProvider(streamCtx, s.config.Client, upstreamRequest, 0)
		if err != nil {
			if comboPick != nil {
				next, nextErr := s.config.Combos.Next(normalized, comboPick, http.StatusBadGateway, "upstream_server_error", err.Error(), "")
				if nextErr == nil {
					comboPick, resolved = next, next.Resolved
					continue
				}
			}
			writeJSONError(w, http.StatusBadGateway, "provider_fetch_error", err.Error())
			return
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			resolvedAuth = auth
			if comboPick != nil {
				s.config.Combos.NoteSuccess(comboPick)
			}
			break
		}
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		_ = response.Body.Close()
		message := strings.TrimSpace(string(payload))
		if comboPick != nil && combos.FailureDecision(response.StatusCode, "upstream_error", message) == combos.DecisionHop {
			next, nextErr := s.config.Combos.Next(normalized, comboPick, response.StatusCode, "upstream_error", message, response.Header.Get("Retry-After"))
			if nextErr == nil {
				comboPick, resolved = next, next.Resolved
				continue
			}
		}
		writeJSONError(w, http.StatusBadGateway, "provider_error", message)
		return
	}
	usageRecord := &types.UsageRecord{RequestID: s.nextRequestID(), ThreadID: r.Header.Get("thread-id"), Provider: resolved.Provider, Model: resolved.Model, StartedAt: requestStarted}
	if resolvedAuth != nil {
		usageRecord.AccountID = resolvedAuth.AccountID
	}
	if body.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		if err := bridge.StreamWithOptions(streamCtx, w, requestedModel, adapter.ParseStream(streamCtx, response.Body), bridge.StreamOptions{StallTimeout: 300 * time.Second, OnCancel: func() { cancelStream(bridge.UpstreamStallError) }, Recorder: s.recorder, Record: usageRecord}); err != nil && !errors.Is(err, context.Canceled) {
			if s.config.Logger != nil {
				s.config.Logger.Error("responses_stream", "error", err)
			}
		}
		return
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "provider_read_error", err.Error())
		return
	}
	events, err := adapter.ParseUnary(streamCtx, payload)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "provider_parse_error", err.Error())
		return
	}
	_, buffered := bridge.Convert(requestedModel, events)
	if terminal := terminalUsage(events); terminal != nil {
		usageRecord.Usage = *terminal
		usageRecord.Status = types.OutcomeSuccess
		usageRecord.Duration = time.Since(usageRecord.StartedAt)
		_ = s.recorder.Record(context.WithoutCancel(streamCtx), usageRecord)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(buffered)
}

func (s *Server) nextRequestID() string {
	return fmt.Sprintf("ocx-%x-%x", time.Now().UnixMilli(), s.sequence.Add(1))
}

func terminalUsage(events []types.AdapterEvent) *types.Usage {
	var found *types.Usage
	for _, event := range events {
		if event.Usage != nil {
			value := *event.Usage
			found = &value
		}
	}
	return found
}

func managementStub(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "status": "management API not configured"})
}
func writeJSONError(w http.ResponseWriter, status int, kind, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": kind, "message": message}})
}
