package types

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
)

type Adapter interface {
	BuildRequest(ctx context.Context, req *NormalizedRequest) (*http.Request, error)
	ParseStream(ctx context.Context, body io.ReadCloser) <-chan AdapterEvent
	ParseUnary(ctx context.Context, body []byte) ([]AdapterEvent, error)
}

type AuthProvider interface {
	ResolveAuth(ctx context.Context, provider string, threadID string) (*AuthContext, error)
	RecordOutcome(account string, status OutcomeStatus, meta *RetryMeta)
}

type Registry interface {
	ResolveModel(selector string) (*ResolvedModel, error)
	ResolveTransport(provider string, cred *AuthContext) (*Transport, error)
	ListModels() []ModelEntry
}

type UsageRecorder interface {
	Record(ctx context.Context, rec *UsageRecord) error
}

type ResponsesParser interface {
	Parse(input json.RawMessage) (*NormalizedRequest, error)
}

type RouteHandler interface {
	Handle(w http.ResponseWriter, r *http.Request)
}

type ComboResolver interface {
	Resolve(comboID string) (*ResolvedCombo, error)
}

type ManagementRouter interface {
	Register(mux *http.ServeMux)
}

type CompactionHandler interface {
	Compact(ctx context.Context, req *CompactionRequest) (*CompactionResult, error)
}

type ChatOutbound interface {
	ToChatCompletions(ctx context.Context, events []AdapterEvent) (*ChatResponse, error)
}
