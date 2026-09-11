package responsesrelay

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestRelaySSEPreservesToolCallUsageAndRawFramesForAllAdapters(t *testing.T) {
	input := "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{}\"}}\n\n" +
		"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":5}}}\n\n"
	for _, adapter := range []Adapter{AdapterOpenAIResponses, AdapterAzure, AdapterAzureOpenAI} {
		var out bytes.Buffer
		result, err := RelaySSE(context.Background(), strings.NewReader(input), &out)
		if err != nil {
			t.Fatalf("%s: RelaySSE() error = %v", adapter, err)
		}
		if out.String() != input {
			t.Errorf("%s changed SSE bytes", adapter)
		}
		if !result.Completed || result.Failed || string(result.Usage) != "{\"input_tokens\":2,\"output_tokens\":5}" || len(result.ToolCalls) != 1 || result.ToolCalls[0].CallID != "call_1" {
			t.Errorf("%s result = %+v", adapter, result)
		}
	}
}

func TestStreamHandlesFragmentedCRLFAndDone(t *testing.T) {
	stream := NewStream()
	input := "data: {\"type\":\"response.created\"}\r\n\r\n" + "data: [DONE]\r\n\r\n"
	var out bytes.Buffer
	for i := 0; i < len(input); i += 3 {
		end := i + 3
		if end > len(input) {
			end = len(input)
		}
		chunk, err := stream.Feed([]byte(input[i:end]))
		if err != nil {
			t.Fatal(err)
		}
		out.Write(chunk)
	}
	if _, err := stream.Finish(); err != nil {
		t.Fatal(err)
	}
	if out.String() != input || !stream.Result().Completed {
		t.Fatalf("output/result mismatch: %q %+v", out.String(), stream.Result())
	}
}

func TestSSEFailsClosedOnMalformedOrIncompleteEvents(t *testing.T) {
	stream := NewStream()
	if _, err := stream.Feed([]byte("data: {not-json}\n\n")); err == nil || !strings.Contains(err.Error(), ErrSSEInvalidJSON.Error()) {
		t.Fatalf("malformed SSE error = %v", err)
	}
	stream = NewStream()
	if _, err := stream.Feed([]byte("data: {\"type\":\"response.completed\"}")); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Finish(); err != ErrSSEUnterminated {
		t.Fatalf("incomplete error = %v", err)
	}
	stream = NewStream()
	if _, err := stream.Feed([]byte("data: {\"type\":\"response.completed\"}\n\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Feed([]byte("data: {\"type\":\"response.created\"}\n\n")); err == nil {
		t.Fatal("post-terminal event was accepted")
	}
}
