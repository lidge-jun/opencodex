package responsesrelay

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildRequestMatrixUsesResponsesWireAndKeyAuth(t *testing.T) {
	for _, adapter := range []Adapter{AdapterOpenAIResponses, AdapterAzure, AdapterAzureOpenAI} {
		provider := Provider{Adapter: adapter, BaseURL: "https://example.test/openai/v1/", AuthMode: "key", APIKey: "secret"}
		req, err := BuildRequest(context.Background(), provider, []byte("{\"model\":\"model-1\",\"input\":\"hi\",\"stream\":false}"))
		if err != nil {
			t.Fatalf("%s: BuildRequest() error = %v", adapter, err)
		}
		if got, want := req.URL.String(), "https://example.test/openai/v1/responses"; got != want {
			t.Errorf("%s URL = %q, want %q", adapter, got, want)
		}
		if got := req.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("%s content type = %q", adapter, got)
		}
		if adapter == AdapterOpenAIResponses {
			if got := req.Header.Get("Authorization"); got != "Bearer secret" {
				t.Errorf("authorization = %q", got)
			}
		} else if got := req.Header.Get("api-key"); got != "secret" {
			t.Errorf("api-key = %q", got)
		}
	}
}

func TestBuildRequestPreservesBodyAndAllowsFunctionTools(t *testing.T) {
	body := []byte("{\"model\":\"m\",\"input\":[{\"type\":\"function_call_output\",\"call_id\":\"c\",\"output\":\"ok\"}],\"tools\":[{\"type\":\"function\",\"name\":\"lookup\",\"parameters\":{\"type\":\"object\"}}],\"stream\":true}")
	req, err := BuildRequest(context.Background(), Provider{Adapter: AdapterOpenAIResponses, BaseURL: "https://example.test/v1", AuthMode: "key", APIKey: "k"}, body)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Fatalf("body changed: got %q want %q", got, body)
	}
}

func TestDoAndReadJSONResponseRelayMatrix(t *testing.T) {
	body := []byte("{\"model\":\"m\",\"input\":\"hi\",\"stream\":false}")
	responseBody := "{\"id\":\"r\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"lookup\",\"arguments\":\"{}\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}"
	for _, adapter := range []Adapter{AdapterOpenAIResponses, AdapterAzure, AdapterAzureOpenAI} {
		t.Run(string(adapter), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/responses" {
					t.Errorf("path = %q, want /v1/responses", r.URL.Path)
				}
				if got := r.Header.Get("Content-Type"); got != "application/json" {
					t.Errorf("content type = %q", got)
				}
				if adapter == AdapterOpenAIResponses {
					if got := r.Header.Get("Authorization"); got != "Bearer secret" {
						t.Errorf("authorization = %q", got)
					}
				} else if got := r.Header.Get("api-key"); got != "secret" {
					t.Errorf("api-key = %q", got)
				}
				got, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("read request body: %v", err)
				}
				if string(got) != string(body) {
					t.Errorf("request body = %q, want %q", got, body)
				}
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, responseBody)
			}))
			defer server.Close()

			resp, err := Do(context.Background(), server.Client(), Provider{
				Adapter: adapter, BaseURL: server.URL, AuthMode: "key", APIKey: "secret",
			}, body)
			if err != nil {
				t.Fatal(err)
			}
			got, err := ReadJSONResponse(resp)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != responseBody {
				t.Fatalf("response = %q, want %q", got, responseBody)
			}
		})
	}
}

func TestUnsupportedProviderAndRequestShapesFailClosed(t *testing.T) {
	cases := []struct {
		name     string
		provider Provider
		body     string
	}{
		{"adapter", Provider{Adapter: "openai-chat", BaseURL: "https://x.test", AuthMode: "key", APIKey: "k"}, "{\"model\":\"m\"}"},
		{"auth", Provider{Adapter: AdapterOpenAIResponses, BaseURL: "https://x.test", AuthMode: "forward", APIKey: "k"}, "{\"model\":\"m\"}"},
		{"azure-key", Provider{Adapter: AdapterAzure, BaseURL: "https://x.test", AuthMode: "key"}, "{\"model\":\"m\"}"},
		{"model", Provider{Adapter: AdapterOpenAIResponses, BaseURL: "https://x.test", AuthMode: "key", APIKey: "k"}, "{\"input\":\"m\"}"},
		{"previous", Provider{Adapter: AdapterOpenAIResponses, BaseURL: "https://x.test", AuthMode: "key", APIKey: "k"}, "{\"model\":\"m\",\"previous_response_id\":\"r\"}"},
		{"hosted-tool", Provider{Adapter: AdapterOpenAIResponses, BaseURL: "https://x.test", AuthMode: "key", APIKey: "k"}, "{\"model\":\"m\",\"tools\":[{\"type\":\"web_search\"}]}"},
		{"unknown-field", Provider{Adapter: AdapterOpenAIResponses, BaseURL: "https://x.test", AuthMode: "key", APIKey: "k"}, "{\"model\":\"m\",\"temperature\":0}"},
		{"stream-options-without-stream", Provider{Adapter: AdapterOpenAIResponses, BaseURL: "https://x.test", AuthMode: "key", APIKey: "k"}, "{\"model\":\"m\",\"stream_options\":{\"include_usage\":true}}"},
		{"placeholder", Provider{Adapter: AdapterAzureOpenAI, BaseURL: "https://{resource}.openai.azure.com/openai", AuthMode: "key", APIKey: "k"}, "{\"model\":\"m\"}"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := BuildRequest(context.Background(), tc.provider, []byte(tc.body))
			if !IsUnsupported(err) {
				t.Fatalf("error = %v, want UnsupportedError", err)
			}
			if got := (&UnsupportedError{}).Code(); got != UnsupportedCode {
				t.Errorf("code = %q", got)
			}
		})
	}
}

func TestReadJSONResponsePreservesUsageAndToolCall(t *testing.T) {
	body := "{\"id\":\"r\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\\\"x\\\"}\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}"
	resp := &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}
	got, err := ReadJSONResponse(resp)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatalf("response changed: got %q want %q", got, body)
	}
}
