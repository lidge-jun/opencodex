package openai

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func decode(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestRequestMatrix(t *testing.T) {
	responses := []byte("{\"model\":\"m\",\"instructions\":\"be concise\",\"input\":\"hello\",\"stream\":true,\"stream_options\":{\"include_usage\":true},\"max_output_tokens\":42,\"tools\":[{\"type\":\"function\",\"name\":\"lookup\",\"description\":\"find\",\"parameters\":{\"type\":\"object\"},\"strict\":true}],\"tool_choice\":{\"type\":\"function\",\"name\":\"lookup\"}}")
	chat, err := ConvertResponsesRequestToChat(responses)
	if err != nil {
		t.Fatal(err)
	}
	got := decode(t, chat)
	if got["model"] != "m" || got["stream"] != true || got["max_tokens"] != float64(42) {
		t.Fatalf("request conversion = %#v", got)
	}
	if got["stream_options"].(map[string]any)["include_usage"] != true {
		t.Fatalf("stream_options = %#v", got["stream_options"])
	}
	chatRequest := []byte("{\"model\":\"m\",\"messages\":[{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\\\"x\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"answer\"}],\"max_tokens\":9}")
	responsesBack, err := ConvertChatRequestToResponses(chatRequest)
	if err != nil {
		t.Fatal(err)
	}
	back := decode(t, responsesBack)
	if back["max_output_tokens"] != float64(9) || back["stream"] != false {
		t.Fatalf("reverse request = %#v", back)
	}
	items := back["input"].([]any)
	if len(items) != 2 {
		t.Fatalf("input items = %#v", items)
	}
}

func TestUnsupportedContract(t *testing.T) {
	for _, test := range []struct {
		name, data string
		fn         func([]byte) ([]byte, error)
	}{
		{"temperature", "{\"model\":\"m\",\"input\":\"x\",\"temperature\":0}", ConvertResponsesRequestToChat},
		{"image", "{\"model\":\"m\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_image\",\"image_url\":\"x\"}]}]}", ConvertResponsesRequestToChat},
		{"response format", "{\"model\":\"m\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"response_format\":{\"type\":\"json_object\"}}", ConvertChatRequestToResponses},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := test.fn([]byte(test.data))
			var target *UnsupportedError
			if !errors.As(err, &target) || target.StatusCode() != 501 || target.Code() != UnsupportedCode {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestResponseUsageAndToolMatrix(t *testing.T) {
	data := []byte("{\"id\":\"r\",\"model\":\"m\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]},{\"type\":\"function_call\",\"call_id\":\"c\",\"name\":\"lookup\",\"arguments\":\"{}\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":4,\"total_tokens\":7}}")
	chat, err := ConvertResponsesResponseToChat(data)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(chat), "tool_calls") || !strings.Contains(string(chat), "prompt_tokens") {
		t.Fatalf("chat = %s", chat)
	}
	back, err := ConvertChatResponseToResponses(chat)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(back), "input_tokens") || !strings.Contains(string(back), "function_call") {
		t.Fatalf("responses = %s", back)
	}
}

func chatFixture(done, reason bool) []byte {
	first := "data: {\"id\":\"c\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hi\"},\"finish_reason\":null}]}\n\n"
	reasonValue := "null"
	if reason {
		reasonValue = "\"stop\""
	}
	value := first + "data: {\"id\":\"c\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":" + reasonValue + "}]}\n\n"
	if done {
		value += "data: [DONE]\n\n"
	}
	return []byte(value)
}

func TestSSETerminalMatrix(t *testing.T) {
	parsed, err := ParseChatSSE(chatFixture(true, true))
	if err != nil || parsed.FinishReason != "stop" {
		t.Fatalf("parsed = %#v err=%v", parsed, err)
	}
	for _, data := range [][]byte{chatFixture(false, false)} {
		if _, err := ParseChatSSE(data); !errors.Is(err, ErrIncompleteSSE) {
			t.Fatalf("err = %v", err)
		}
	}
	if parsed, err := ParseChatSSE(chatFixture(true, false)); err != nil || parsed.FinishReason != "" {
		t.Fatalf("[DONE]-terminated stream = %#v err=%v", parsed, err)
	}
}

func TestSSEConversionsCRLFAndToolCalls(t *testing.T) {
	chat := "data: {\"id\":\"c\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello\"},\"finish_reason\":null}]}\r\n\r\ndata: {\"id\":\"c\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"total_tokens\":7}}\r\n\r\ndata: [DONE]\r\n\r\n"
	responses, err := ConvertChatSSEToResponses([]byte(chat))
	if err != nil || !strings.Contains(string(responses), "response.output_text.delta") {
		t.Fatalf("responses = %s err=%v", responses, err)
	}
	back, err := ConvertResponsesSSEToChat(responses)
	if err != nil || !strings.Contains(string(back), "finish_reason") {
		t.Fatalf("back = %s err=%v", back, err)
	}
	tool := "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"model\":\"m\"}}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"c\",\"name\":\"lookup\"}}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{}\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\ndata: [DONE]\n\n"
	converted, err := ConvertResponsesSSEToChat([]byte(tool))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(converted), "tool_calls") || !strings.Contains(string(converted), "finish_reason") {
		t.Fatalf("converted tool stream = %s", converted)
	}
}
