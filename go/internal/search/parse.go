package search

import (
	"encoding/json"
	"io"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
)

var (
	urlPattern    = regexp.MustCompile(`https?://[^\s<>()\[\]]+`)
	sourcesHeader = regexp.MustCompile(`(?i)^\s*(?:#{1,6}\s*)?[-*>\s]*\**\s*sources?\s*\**\s*:?\s*\**\s*$`)
)

// ParseOpenAISSE folds a Responses SSE stream into its authoritative answer and citations.
func ParseOpenAISSE(reader io.Reader) (Result, error) {
	var deltaText, doneText, finalText, streamError string
	sources := make([]Source, 0, 8)
	seen := make(map[string]bool)
	err := consumeSSE(reader, func(event protocol.SSEEvent) {
		if event.Data == "[DONE]" {
			return
		}
		var data map[string]any
		if json.Unmarshal([]byte(event.Data), &data) != nil {
			return
		}
		switch stringValue(data["type"]) {
		case "response.output_text.delta":
			deltaText += stringValue(data["delta"])
		case "response.output_text.done":
			doneText += stringValue(data["text"])
		case "response.completed", "response.done":
			if response, ok := data["response"].(map[string]any); ok {
				finalText += collectOpenAIOutput(response["output"], &sources, seen)
			}
		case "response.failed", "response.incomplete", "error":
			streamError = eventError(data)
		}
		if annotation, ok := data["annotation"].(map[string]any); ok {
			collectOpenAIAnnotation(annotation, &sources, seen)
		}
	})
	if err != nil {
		return Result{}, err
	}
	text := firstNonBlank(finalText, doneText, deltaText)
	body, trailing := extractTrailingSources(text)
	for _, source := range trailing {
		addSource(&sources, seen, source.URL, source.Title)
	}
	if len(trailing) > 0 {
		text = body
	}
	result := Result{Text: text, Sources: sources}
	if strings.TrimSpace(text) == "" {
		result.Error = streamError
	}
	return result, nil
}

// ParseAnthropicSSE folds Messages SSE text, hosted-tool results, and citation deltas.
func ParseAnthropicSSE(reader io.Reader) (Result, error) {
	var text string
	sources := make([]Source, 0, 8)
	seen := make(map[string]bool)
	sawToolError := false
	err := consumeSSE(reader, func(event protocol.SSEEvent) {
		if event.Data == "[DONE]" {
			return
		}
		var data map[string]any
		if json.Unmarshal([]byte(event.Data), &data) != nil {
			return
		}
		switch stringValue(data["type"]) {
		case "content_block_start":
			block, _ := data["content_block"].(map[string]any)
			if block["type"] == "web_search_tool_result" {
				items, _ := block["content"].([]any)
				for _, raw := range items {
					item, _ := raw.(map[string]any)
					if item["type"] == "web_search_result" {
						addSource(&sources, seen, stringValue(item["url"]), stringValue(item["title"]))
					} else if item["type"] == "web_search_tool_result_error" {
						sawToolError = true
					}
				}
			}
		case "content_block_delta":
			delta, _ := data["delta"].(map[string]any)
			if delta["type"] == "text_delta" {
				text += stringValue(delta["text"])
			} else if delta["type"] == "citations_delta" {
				citation, _ := delta["citation"].(map[string]any)
				if citation["type"] == "web_search_result_location" {
					addSource(&sources, seen, stringValue(citation["url"]), stringValue(citation["title"]))
				}
			}
		}
	})
	if err != nil {
		return Result{}, err
	}
	result := Result{Text: strings.TrimSpace(text), Sources: sources}
	if result.Text == "" {
		if sawToolError {
			result.Error = "anthropic web search returned an error result"
		} else {
			result.Error = "anthropic sidecar produced no answer"
		}
	}
	return result, nil
}

func consumeSSE(reader io.Reader, accept func(protocol.SSEEvent)) error {
	events := make(chan protocol.SSEEvent)
	decoder := protocol.NewSSEDecoder(events)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for event := range events {
			accept(event)
		}
	}()
	_, copyErr := io.Copy(decoder, reader)
	closeErr := decoder.Close()
	close(events)
	<-done
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func collectOpenAIOutput(raw any, sources *[]Source, seen map[string]bool) string {
	items, _ := raw.([]any)
	var text string
	for _, rawItem := range items {
		item, _ := rawItem.(map[string]any)
		if item["type"] != "message" {
			continue
		}
		content, _ := item["content"].([]any)
		for _, rawBlock := range content {
			block, _ := rawBlock.(map[string]any)
			if block["type"] != "output_text" {
				continue
			}
			text += stringValue(block["text"])
			annotations, _ := block["annotations"].([]any)
			for _, rawAnnotation := range annotations {
				annotation, _ := rawAnnotation.(map[string]any)
				collectOpenAIAnnotation(annotation, sources, seen)
			}
		}
	}
	return text
}

func collectOpenAIAnnotation(annotation map[string]any, sources *[]Source, seen map[string]bool) {
	if annotation["type"] == "url_citation" {
		addSource(sources, seen, stringValue(annotation["url"]), stringValue(annotation["title"]))
	}
}

func extractTrailingSources(text string) (string, []Source) {
	lines := strings.Split(text, "\n")
	header := -1
	for index := len(lines) - 1; index >= 0; index-- {
		if sourcesHeader.MatchString(lines[index]) {
			header = index
			break
		}
	}
	if header < 0 {
		return text, nil
	}
	var sources []Source
	last := header
	for index := header + 1; index < len(lines); index++ {
		line := strings.TrimSpace(lines[index])
		if line == "" {
			if len(sources) > 0 {
				break
			}
			continue
		}
		location := urlPattern.FindStringIndex(line)
		if location == nil {
			break
		}
		url := strings.TrimRight(line[location[0]:location[1]], ")>].,;:")
		title := strings.Trim(strings.TrimSpace(line[:location[0]]), "-*#>[]()0123456789. :—")
		sources = append(sources, Source{URL: url, Title: title})
		last = index
	}
	if len(sources) == 0 {
		return text, nil
	}
	before := strings.TrimSpace(strings.Join(lines[:header], "\n"))
	after := strings.TrimSpace(strings.Join(lines[last+1:], "\n"))
	return strings.TrimSpace(strings.Join(nonEmpty(before, after), "\n\n")), sources
}

func addSource(sources *[]Source, seen map[string]bool, url, title string) {
	if url == "" || seen[url] {
		return
	}
	seen[url] = true
	*sources = append(*sources, Source{URL: url, Title: title})
}

func eventError(data map[string]any) string {
	if response, ok := data["response"].(map[string]any); ok {
		if nested, ok := response["error"].(map[string]any); ok && stringValue(nested["message"]) != "" {
			return stringValue(nested["message"])
		}
	}
	if nested, ok := data["error"].(map[string]any); ok {
		return stringValue(nested["message"])
	}
	return stringValue(data["message"])
}

func stringValue(value any) string { valueString, _ := value.(string); return valueString }
func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
func nonEmpty(values ...string) []string {
	output := values[:0]
	for _, value := range values {
		if value != "" {
			output = append(output, value)
		}
	}
	return output
}
