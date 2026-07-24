package types

import (
	"encoding/json"
	"time"
)

type NormalizedRequest struct {
	ModelID            string            `json:"modelId"`
	PreviousResponseID string            `json:"previousResponseId,omitempty"`
	Context            RequestContext    `json:"context"`
	Stream             bool              `json:"stream"`
	Options            RequestOptions    `json:"options"`
	RawBody            json.RawMessage   `json:"-"`
	Metadata           map[string]string `json:"metadata,omitempty"`
}

type RequestContext struct {
	SystemPrompt []string  `json:"systemPrompt,omitempty"`
	Messages     []Message `json:"messages"`
	Tools        []Tool    `json:"tools,omitempty"`
}

type Message struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"toolCallId,omitempty"`
	ToolName   string          `json:"toolName,omitempty"`
	IsError    bool            `json:"isError,omitempty"`
	Timestamp  int64           `json:"timestamp,omitempty"`
}

type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
	Strict      bool           `json:"strict,omitempty"`
	Namespace   string         `json:"namespace,omitempty"`
}

type RequestOptions struct {
	MaxOutputTokens   int             `json:"maxOutputTokens,omitempty"`
	Temperature       *float64        `json:"temperature,omitempty"`
	TopP              *float64        `json:"topP,omitempty"`
	StopSequences     []string        `json:"stopSequences,omitempty"`
	ToolChoice        json.RawMessage `json:"toolChoice,omitempty"`
	ParallelToolCalls *bool           `json:"parallelToolCalls,omitempty"`
	Reasoning         string          `json:"reasoning,omitempty"`
	ServiceTier       string          `json:"serviceTier,omitempty"`
}

type AdapterEventType string

const (
	EventTextDelta AdapterEventType = "text_delta"
	EventToolCall  AdapterEventType = "tool_call"
	EventReasoning AdapterEventType = "reasoning"
	EventUsage     AdapterEventType = "usage"
	EventError     AdapterEventType = "error"
	EventDone      AdapterEventType = "done"
	// EventHeartbeat is a liveness signal with no payload (TS src/types.ts:237).
	// Consumers must treat it as activity only and never emit it downstream.
	EventHeartbeat AdapterEventType = "heartbeat"
	// EventIncomplete ends a turn early for a structured reason
	// (TS src/types.ts:264). Terminal like done/error.
	EventIncomplete AdapterEventType = "incomplete"
)

type AdapterEvent struct {
	Type       AdapterEventType `json:"type"`
	Text       string           `json:"text,omitempty"`
	Phase      string           `json:"phase,omitempty"`
	Reasoning  string           `json:"reasoning,omitempty"`
	ToolCall   *ToolCall        `json:"toolCall,omitempty"`
	Usage      *Usage           `json:"usage,omitempty"`
	Error      string           `json:"error,omitempty"`
	StatusCode int              `json:"statusCode,omitempty"`
	Retryable  bool             `json:"retryable,omitempty"`
	StopReason string           `json:"stopReason,omitempty"`
	// Reason/Message carry EventIncomplete details
	// (e.g. "max_output_tokens", "content_filter", "adapter_eof",
	// "upstream_stall_timeout").
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type Usage struct {
	InputTokens              int  `json:"inputTokens"`
	OutputTokens             int  `json:"outputTokens"`
	TotalTokens              int  `json:"totalTokens,omitempty"`
	CachedInputTokens        int  `json:"cachedInputTokens,omitempty"`
	CacheReadInputTokens     int  `json:"cacheReadInputTokens,omitempty"`
	CacheCreationInputTokens int  `json:"cacheCreationInputTokens,omitempty"`
	ReasoningOutputTokens    int  `json:"reasoningOutputTokens,omitempty"`
	Estimated                bool `json:"estimated,omitempty"`
}

type AuthContext struct {
	Kind             string            `json:"kind"`
	Provider         string            `json:"provider"`
	AccountID        string            `json:"accountId,omitempty"`
	Generation       int64             `json:"generation,omitempty"`
	AccessToken      string            `json:"-"`
	APIKey           string            `json:"-"`
	ChatGPTAccountID string            `json:"chatgptAccountId,omitempty"`
	Headers          map[string]string `json:"-"`
}

type ResolvedModel struct {
	Selector string `json:"selector"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Effort   string `json:"effort,omitempty"`
}

type Transport struct {
	BaseURL string            `json:"baseUrl"`
	Headers map[string]string `json:"headers,omitempty"`
}

type UsageRecord struct {
	RequestID string        `json:"requestId"`
	ThreadID  string        `json:"threadId,omitempty"`
	Provider  string        `json:"provider"`
	Model     string        `json:"model"`
	AccountID string        `json:"accountId,omitempty"`
	Usage     Usage         `json:"usage"`
	Status    OutcomeStatus `json:"status"`
	StartedAt time.Time     `json:"startedAt"`
	Duration  time.Duration `json:"duration"`
}

type OutcomeStatus string

const (
	OutcomeSuccess       OutcomeStatus = "success"
	OutcomeAuthError     OutcomeStatus = "auth_error"
	OutcomeRateLimited   OutcomeStatus = "rate_limited"
	OutcomeProviderError OutcomeStatus = "provider_error"
	OutcomeCancelled     OutcomeStatus = "cancelled"
)

type RetryMeta struct {
	Attempt      int           `json:"attempt"`
	MaxAttempts  int           `json:"maxAttempts,omitempty"`
	RetryAfter   time.Duration `json:"retryAfter,omitempty"`
	StatusCode   int           `json:"statusCode,omitempty"`
	ProviderCode string        `json:"providerCode,omitempty"`
	Message      string        `json:"message,omitempty"`
}

type CompactionRequest struct {
	Model    string            `json:"model"`
	Input    []json.RawMessage `json:"input"`
	ThreadID string            `json:"threadId,omitempty"`
}

type CompactionResult struct {
	Summary          string            `json:"summary"`
	EncryptedContent string            `json:"encryptedContent,omitempty"`
	Output           []json.RawMessage `json:"output,omitempty"`
	Usage            *Usage            `json:"usage,omitempty"`
}

type ChatResponse struct {
	ID      string       `json:"id"`
	Object  string       `json:"object"`
	Created int64        `json:"created"`
	Model   string       `json:"model"`
	Choices []ChatChoice `json:"choices"`
	Usage   *ChatUsage   `json:"usage,omitempty"`
}

type ChatChoice struct {
	Index        int         `json:"index"`
	Message      ChatMessage `json:"message"`
	FinishReason string      `json:"finish_reason,omitempty"`
}

type ChatMessage struct {
	Role      string     `json:"role"`
	Content   string     `json:"content,omitempty"`
	Reasoning string     `json:"reasoning_content,omitempty"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
}

type ChatUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type ModelEntry struct {
	ID               string   `json:"id"`
	Provider         string   `json:"provider"`
	DisplayName      string   `json:"displayName,omitempty"`
	ReasoningEfforts []string `json:"reasoningEfforts,omitempty"`
	ContextWindow    int      `json:"contextWindow,omitempty"`
}

type ResolvedCombo struct {
	ID            string            `json:"id"`
	Strategy      string            `json:"strategy"`
	Targets       []ResolvedModel   `json:"targets"`
	DefaultEffort string            `json:"defaultEffort,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}
