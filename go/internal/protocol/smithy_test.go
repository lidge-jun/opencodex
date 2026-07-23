package protocol

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSmithyRoundTripAllHeaderTypes(t *testing.T) {
	stamp := time.Date(2026, 7, 24, 1, 2, 3, 456000000, time.UTC)
	uuid := SmithyUUID{0x12, 0x34, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78}
	frame := &SmithyFrame{
		Headers: map[string]SmithyHeaderValue{
			"true":   {Type: SmithyHeaderBool, Value: true},
			"false":  {Type: SmithyHeaderBool, Value: false},
			"byte":   {Type: SmithyHeaderByte, Value: int8(-12)},
			"short":  {Type: SmithyHeaderShort, Value: int16(-1234)},
			"int":    {Type: SmithyHeaderInteger, Value: int32(-123456)},
			"long":   {Type: SmithyHeaderLong, Value: int64(-1234567890123)},
			"bytes":  {Type: SmithyHeaderBytes, Value: []byte{0, 1, 255}},
			"string": {Type: SmithyHeaderString, Value: "hello, 세계"},
			"time":   {Type: SmithyHeaderTimestamp, Value: stamp},
			"uuid":   {Type: SmithyHeaderUUID, Value: uuid},
		},
		Payload: []byte("payload"),
	}

	var encoded bytes.Buffer
	if err := EncodeSmithyFrame(&encoded, frame); err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeSmithyFrame(&encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, frame) {
		t.Fatalf("decoded = %#v, want %#v", decoded, frame)
	}
}

func TestSmithyRejectsCRCFailures(t *testing.T) {
	frame := &SmithyFrame{Headers: map[string]SmithyHeaderValue{"kind": {Type: SmithyHeaderString, Value: "event"}}, Payload: []byte("body")}
	var encoded bytes.Buffer
	if err := EncodeSmithyFrame(&encoded, frame); err != nil {
		t.Fatal(err)
	}

	preludeBad := append([]byte(nil), encoded.Bytes()...)
	preludeBad[8] ^= 0xff
	if _, err := DecodeSmithyFrame(bytes.NewReader(preludeBad)); err == nil || !strings.Contains(err.Error(), "prelude CRC") {
		t.Fatalf("prelude error = %v", err)
	}

	messageBad := append([]byte(nil), encoded.Bytes()...)
	messageBad[len(messageBad)-5] ^= 0xff
	if _, err := DecodeSmithyFrame(bytes.NewReader(messageBad)); err == nil || !strings.Contains(err.Error(), "message CRC") {
		t.Fatalf("message error = %v", err)
	}
}

func TestSmithyRejectsInvalidEncodingValues(t *testing.T) {
	frame := &SmithyFrame{Headers: map[string]SmithyHeaderValue{
		"wrong": {Type: SmithyHeaderInteger, Value: int64(1)},
	}}
	if err := EncodeSmithyFrame(&bytes.Buffer{}, frame); err == nil {
		t.Fatal("expected type error")
	}
}
