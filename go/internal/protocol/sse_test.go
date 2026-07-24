package protocol

import (
	"strings"
	"testing"
)

func TestSSEDecoderPartialChunksAndFields(t *testing.T) {
	events := make(chan SSEEvent, 4)
	decoder := NewSSEDecoder(events)
	chunks := []string{
		"id: 42\nev", "ent: tool\ndata: first", " line\r\ndata: second\n",
		"retry: 1500\n\n: comment\ndata: final",
	}
	for _, chunk := range chunks {
		if n, err := decoder.Write([]byte(chunk)); err != nil || n != len(chunk) {
			t.Fatalf("Write() = %d, %v", n, err)
		}
	}
	if err := decoder.Close(); err != nil {
		t.Fatal(err)
	}

	first := <-events
	if want := (SSEEvent{Event: "tool", Data: "first line\nsecond", ID: "42", Retry: 1500}); first != want {
		t.Fatalf("first event = %#v, want %#v", first, want)
	}
	second := <-events
	if want := (SSEEvent{Data: "final", ID: "42", Retry: 1500}); second != want {
		t.Fatalf("final event = %#v, want %#v", second, want)
	}
}

func TestSSEDecoderIgnoresEmptyAndUnknownRecords(t *testing.T) {
	events := make(chan SSEEvent, 2)
	decoder := NewSSEDecoder(events)
	input := "\nretry: nope\nid: bad\x00id\nunknown: value\n\ndata:\n\n"
	if _, err := decoder.Write([]byte(input)); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Close(); err != nil {
		t.Fatal(err)
	}
	if got := <-events; got != (SSEEvent{Data: ""}) {
		t.Fatalf("event = %#v", got)
	}
	select {
	case extra := <-events:
		t.Fatalf("unexpected event: %#v", extra)
	default:
	}
}

func TestSSEDecoderSupportsLargeLines(t *testing.T) {
	events := make(chan SSEEvent, 1)
	decoder := NewSSEDecoder(events)
	data := strings.Repeat("x", 128*1024)
	if _, err := decoder.Write([]byte("data: " + data + "\n\n")); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Close(); err != nil {
		t.Fatal(err)
	}
	if got := <-events; got.Data != data {
		t.Fatalf("data length = %d, want %d", len(got.Data), len(data))
	}
}

func TestSSEDecoderCommentsAreOptIn(t *testing.T) {
	input := ": keepalive\n\n"

	defaultEvents := make(chan SSEEvent, 1)
	defaultDecoder := NewSSEDecoder(defaultEvents)
	if _, err := defaultDecoder.Write([]byte(input)); err != nil {
		t.Fatal(err)
	}
	if err := defaultDecoder.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-defaultEvents:
		t.Fatalf("default decoder surfaced comment: %#v", event)
	default:
	}

	commentEvents := make(chan SSEEvent, 1)
	commentDecoder := NewSSEDecoderWithComments(commentEvents)
	if _, err := commentDecoder.Write([]byte(input)); err != nil {
		t.Fatal(err)
	}
	if err := commentDecoder.Close(); err != nil {
		t.Fatal(err)
	}
	event := <-commentEvents
	if event.Comment == nil || *event.Comment != "keepalive" {
		t.Fatalf("comment event = %#v", event)
	}
}
