package e2e

import (
	"bytes"
	"encoding/binary"
	"io"
	"net/http"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestCursorTransportInstantiationWithMockTransport(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(nil)), Header: make(http.Header)}, nil
	})}
	transport, err := cursor.NewLiveTransport(cursor.TransportConfig{BaseURL: "https://cursor.test", Token: "mock-token", Client: client})
	if err != nil {
		t.Fatalf("NewLiveTransport() error = %v", err)
	}
	if transport == nil || transport.RequestCommitted() {
		t.Fatalf("transport = %#v, committed = %v", transport, transport.RequestCommitted())
	}
}

func TestCursorProtobufFrameRoundTrip(t *testing.T) {
	want := cursor.ConnectFrame{Flags: cursor.ConnectFlagEndStream, Payload: protoBytesField(1, []byte("protobuf"))}
	encoded, err := cursor.EncodeFrame(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := cursor.ReadFrame(bytes.NewReader(encoded), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if got.Flags != want.Flags || !bytes.Equal(got.Payload, want.Payload) || !got.EndStream() {
		t.Fatalf("decoded frame = %#v, want %#v", got, want)
	}
}

func TestCursorEventParsingFromMockProtobuf(t *testing.T) {
	parser := cursor.NewEventParser()
	text := protoBytesField(1, []byte("cursor canned"))
	interaction := protoBytesField(1, text)
	events, err := parser.Parse(protoBytesField(1, interaction))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != types.EventTextDelta || events[0].Text != "cursor canned" {
		t.Fatalf("text events = %#v", events)
	}

	outputTokens := protoVarintField(1, 3)
	terminal := append(protoBytesField(8, outputTokens), protoBytesField(14, nil)...)
	events, err = parser.Parse(protoBytesField(1, terminal))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != types.EventDone || events[0].Usage == nil || events[0].Usage.OutputTokens != 3 {
		t.Fatalf("terminal events = %#v", events)
	}
}

func protoBytesField(number int, payload []byte) []byte {
	result := protoVarint(uint64(number<<3 | 2))
	result = append(result, protoVarint(uint64(len(payload)))...)
	return append(result, payload...)
}

func protoVarintField(number int, value uint64) []byte {
	return append(protoVarint(uint64(number<<3)), protoVarint(value)...)
}

func protoVarint(value uint64) []byte {
	var buffer [binary.MaxVarintLen64]byte
	length := binary.PutUvarint(buffer[:], value)
	return append([]byte(nil), buffer[:length]...)
}
