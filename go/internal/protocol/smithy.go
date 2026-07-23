package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math"
	"sort"
	"time"
)

const (
	smithyPreludeLen   = 8
	smithyPreludeBlock = 12
	smithyMinFrameLen  = 16
	smithyMaxFrameLen  = 16 * 1024 * 1024
	smithyMaxHeaders   = 128 * 1024
)

// SmithyHeaderType identifies a Smithy event-stream header value type.
type SmithyHeaderType uint8

const (
	SmithyHeaderBool SmithyHeaderType = iota
	SmithyHeaderByte
	SmithyHeaderShort
	SmithyHeaderInteger
	SmithyHeaderLong
	SmithyHeaderBytes
	SmithyHeaderString
	SmithyHeaderTimestamp
	SmithyHeaderUUID
)

// SmithyUUID is the 16-byte wire representation of a UUID.
type SmithyUUID [16]byte

type SmithyFrame struct {
	Headers map[string]SmithyHeaderValue
	Payload []byte
}

type SmithyHeaderValue struct {
	Type  SmithyHeaderType
	Value interface{}
}

// DecodeSmithyFrame reads and validates exactly one Smithy event-stream frame.
func DecodeSmithyFrame(r io.Reader) (*SmithyFrame, error) {
	prelude := make([]byte, smithyPreludeBlock)
	if _, err := io.ReadFull(r, prelude); err != nil {
		return nil, fmt.Errorf("eventstream: read prelude: %w", err)
	}
	total := binary.BigEndian.Uint32(prelude[:4])
	headersLen := binary.BigEndian.Uint32(prelude[4:8])
	if total < smithyMinFrameLen {
		return nil, fmt.Errorf("eventstream: total length %d below minimum", total)
	}
	if total > smithyMaxFrameLen {
		return nil, fmt.Errorf("eventstream: total length %d exceeds maximum", total)
	}
	if headersLen > smithyMaxHeaders {
		return nil, fmt.Errorf("eventstream: headers length %d exceeds maximum", headersLen)
	}
	if headersLen > total-smithyMinFrameLen {
		return nil, errors.New("eventstream: headers length exceeds frame payload")
	}
	if got, want := crc32.ChecksumIEEE(prelude[:smithyPreludeLen]), binary.BigEndian.Uint32(prelude[8:12]); got != want {
		return nil, errors.New("eventstream: prelude CRC mismatch")
	}

	rest := make([]byte, int(total)-smithyPreludeBlock)
	if _, err := io.ReadFull(r, rest); err != nil {
		return nil, fmt.Errorf("eventstream: truncated frame: %w", err)
	}
	message := append(prelude, rest...)
	wantCRC := binary.BigEndian.Uint32(message[len(message)-4:])
	if crc32.ChecksumIEEE(message[:len(message)-4]) != wantCRC {
		return nil, errors.New("eventstream: message CRC mismatch")
	}

	headers, err := decodeSmithyHeaders(message[smithyPreludeBlock : smithyPreludeBlock+int(headersLen)])
	if err != nil {
		return nil, err
	}
	payloadStart := smithyPreludeBlock + int(headersLen)
	payload := append([]byte(nil), message[payloadStart:len(message)-4]...)
	return &SmithyFrame{Headers: headers, Payload: payload}, nil
}

// EncodeSmithyFrame writes one complete Smithy event-stream frame.
func EncodeSmithyFrame(w io.Writer, frame *SmithyFrame) error {
	if frame == nil {
		return errors.New("eventstream: nil frame")
	}
	var headers bytes.Buffer
	keys := make([]string, 0, len(frame.Headers))
	for key := range frame.Headers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := encodeSmithyHeader(&headers, key, frame.Headers[key]); err != nil {
			return err
		}
	}
	if headers.Len() > smithyMaxHeaders {
		return fmt.Errorf("eventstream: headers length %d exceeds maximum", headers.Len())
	}
	total := smithyMinFrameLen + headers.Len() + len(frame.Payload)
	if total > smithyMaxFrameLen {
		return fmt.Errorf("eventstream: total length %d exceeds maximum", total)
	}

	message := make([]byte, total)
	binary.BigEndian.PutUint32(message[:4], uint32(total))
	binary.BigEndian.PutUint32(message[4:8], uint32(headers.Len()))
	binary.BigEndian.PutUint32(message[8:12], crc32.ChecksumIEEE(message[:8]))
	copy(message[12:], headers.Bytes())
	copy(message[12+headers.Len():], frame.Payload)
	binary.BigEndian.PutUint32(message[total-4:], crc32.ChecksumIEEE(message[:total-4]))
	if n, err := w.Write(message); err != nil {
		return fmt.Errorf("eventstream: write frame: %w", err)
	} else if n != len(message) {
		return io.ErrShortWrite
	}
	return nil
}

func decodeSmithyHeaders(data []byte) (map[string]SmithyHeaderValue, error) {
	r := bytes.NewReader(data)
	headers := make(map[string]SmithyHeaderValue)
	for r.Len() > 0 {
		nameLen, err := r.ReadByte()
		if err != nil {
			return nil, errors.New("eventstream: truncated header name length")
		}
		nameBytes := make([]byte, int(nameLen))
		if _, err := io.ReadFull(r, nameBytes); err != nil {
			return nil, errors.New("eventstream: truncated header name")
		}
		wireType, err := r.ReadByte()
		if err != nil {
			return nil, errors.New("eventstream: truncated header type")
		}
		value, err := decodeSmithyHeaderValue(r, wireType)
		if err != nil {
			return nil, fmt.Errorf("eventstream: header %q: %w", string(nameBytes), err)
		}
		headers[string(nameBytes)] = value
	}
	return headers, nil
}

func decodeSmithyHeaderValue(r *bytes.Reader, wireType byte) (SmithyHeaderValue, error) {
	switch wireType {
	case 0:
		return SmithyHeaderValue{Type: SmithyHeaderBool, Value: true}, nil
	case 1:
		return SmithyHeaderValue{Type: SmithyHeaderBool, Value: false}, nil
	case 2:
		var v int8
		return valueAfterRead(SmithyHeaderByte, &v, r)
	case 3:
		var v int16
		return valueAfterRead(SmithyHeaderShort, &v, r)
	case 4:
		var v int32
		return valueAfterRead(SmithyHeaderInteger, &v, r)
	case 5:
		var v int64
		return valueAfterRead(SmithyHeaderLong, &v, r)
	case 6:
		b, err := readLengthPrefixed(r)
		return SmithyHeaderValue{Type: SmithyHeaderBytes, Value: b}, err
	case 7:
		b, err := readLengthPrefixed(r)
		return SmithyHeaderValue{Type: SmithyHeaderString, Value: string(b)}, err
	case 8:
		var millis int64
		if err := binary.Read(r, binary.BigEndian, &millis); err != nil {
			return SmithyHeaderValue{}, errors.New("truncated timestamp value")
		}
		return SmithyHeaderValue{Type: SmithyHeaderTimestamp, Value: time.UnixMilli(millis).UTC()}, nil
	case 9:
		var uuid SmithyUUID
		if _, err := io.ReadFull(r, uuid[:]); err != nil {
			return SmithyHeaderValue{}, errors.New("truncated uuid value")
		}
		return SmithyHeaderValue{Type: SmithyHeaderUUID, Value: uuid}, nil
	default:
		return SmithyHeaderValue{}, fmt.Errorf("unknown header value type %d", wireType)
	}
}

func valueAfterRead(kind SmithyHeaderType, value interface{}, r io.Reader) (SmithyHeaderValue, error) {
	if err := binary.Read(r, binary.BigEndian, value); err != nil {
		return SmithyHeaderValue{}, errors.New("truncated numeric value")
	}
	switch v := value.(type) {
	case *int8:
		return SmithyHeaderValue{Type: kind, Value: *v}, nil
	case *int16:
		return SmithyHeaderValue{Type: kind, Value: *v}, nil
	case *int32:
		return SmithyHeaderValue{Type: kind, Value: *v}, nil
	case *int64:
		return SmithyHeaderValue{Type: kind, Value: *v}, nil
	default:
		panic("unsupported Smithy numeric type")
	}
}

func readLengthPrefixed(r *bytes.Reader) ([]byte, error) {
	var length uint16
	if err := binary.Read(r, binary.BigEndian, &length); err != nil {
		return nil, errors.New("truncated value length")
	}
	b := make([]byte, int(length))
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, errors.New("truncated value")
	}
	return b, nil
}

func encodeSmithyHeader(w *bytes.Buffer, name string, header SmithyHeaderValue) error {
	if len(name) > math.MaxUint8 {
		return fmt.Errorf("eventstream: header name %q exceeds 255 bytes", name)
	}
	w.WriteByte(byte(len(name)))
	w.WriteString(name)

	switch header.Type {
	case SmithyHeaderBool:
		v, ok := header.Value.(bool)
		if !ok {
			return headerTypeError(name, "bool")
		}
		if v {
			w.WriteByte(0)
		} else {
			w.WriteByte(1)
		}
	case SmithyHeaderByte:
		v, ok := header.Value.(int8)
		if !ok {
			return headerTypeError(name, "int8")
		}
		w.WriteByte(2)
		w.WriteByte(byte(v))
	case SmithyHeaderShort:
		v, ok := header.Value.(int16)
		if !ok {
			return headerTypeError(name, "int16")
		}
		w.WriteByte(3)
		binary.Write(w, binary.BigEndian, v)
	case SmithyHeaderInteger:
		v, ok := header.Value.(int32)
		if !ok {
			return headerTypeError(name, "int32")
		}
		w.WriteByte(4)
		binary.Write(w, binary.BigEndian, v)
	case SmithyHeaderLong:
		v, ok := header.Value.(int64)
		if !ok {
			return headerTypeError(name, "int64")
		}
		w.WriteByte(5)
		binary.Write(w, binary.BigEndian, v)
	case SmithyHeaderBytes:
		v, ok := header.Value.([]byte)
		if !ok {
			return headerTypeError(name, "[]byte")
		}
		if err := writeLengthPrefixed(w, v); err != nil {
			return fmt.Errorf("eventstream: header %q: %w", name, err)
		}
	case SmithyHeaderString:
		v, ok := header.Value.(string)
		if !ok {
			return headerTypeError(name, "string")
		}
		w.WriteByte(7)
		if err := writeLengthPrefixedValue(w, []byte(v)); err != nil {
			return fmt.Errorf("eventstream: header %q: %w", name, err)
		}
		return nil
	case SmithyHeaderTimestamp:
		w.WriteByte(8)
		switch v := header.Value.(type) {
		case time.Time:
			binary.Write(w, binary.BigEndian, v.UnixMilli())
		case int64:
			binary.Write(w, binary.BigEndian, v)
		default:
			return headerTypeError(name, "time.Time or int64 milliseconds")
		}
	case SmithyHeaderUUID:
		w.WriteByte(9)
		switch v := header.Value.(type) {
		case SmithyUUID:
			w.Write(v[:])
		case [16]byte:
			w.Write(v[:])
		case []byte:
			if len(v) != 16 {
				return headerTypeError(name, "16-byte UUID")
			}
			w.Write(v)
		default:
			return headerTypeError(name, "SmithyUUID or 16-byte value")
		}
	default:
		return fmt.Errorf("eventstream: header %q has unknown type %d", name, header.Type)
	}
	return nil
}

func writeLengthPrefixed(w *bytes.Buffer, value []byte) error {
	w.WriteByte(6)
	return writeLengthPrefixedValue(w, value)
}

func writeLengthPrefixedValue(w *bytes.Buffer, value []byte) error {
	if len(value) > math.MaxUint16 {
		return fmt.Errorf("value length %d exceeds 65535 bytes", len(value))
	}
	binary.Write(w, binary.BigEndian, uint16(len(value)))
	w.Write(value)
	return nil
}

func headerTypeError(name, want string) error {
	return fmt.Errorf("eventstream: header %q value must be %s", name, want)
}
