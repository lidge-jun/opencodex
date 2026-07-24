package cursor

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const (
	ConnectHeaderBytes         = 5
	ConnectFlagCompressed byte = 0x01
	ConnectFlagEndStream  byte = 0x02
	DefaultMaxFrameSize        = 32 << 20
)

type ConnectFrame struct {
	Flags   byte
	Payload []byte
}

func (f ConnectFrame) Compressed() bool { return f.Flags&ConnectFlagCompressed != 0 }
func (f ConnectFrame) EndStream() bool  { return f.Flags&ConnectFlagEndStream != 0 }

func EncodeFrame(frame ConnectFrame) ([]byte, error) {
	if uint64(len(frame.Payload)) > uint64(^uint32(0)) {
		return nil, fmt.Errorf("connect payload too large: %d", len(frame.Payload))
	}
	out := make([]byte, ConnectHeaderBytes+len(frame.Payload))
	out[0] = frame.Flags
	binary.BigEndian.PutUint32(out[1:5], uint32(len(frame.Payload)))
	copy(out[5:], frame.Payload)
	return out, nil
}

func ReadFrame(r io.Reader, maxPayload int) (ConnectFrame, error) {
	if maxPayload <= 0 {
		maxPayload = DefaultMaxFrameSize
	}
	var header [ConnectHeaderBytes]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return ConnectFrame{}, err
	}
	length := binary.BigEndian.Uint32(header[1:])
	if uint64(length) > uint64(maxPayload) {
		return ConnectFrame{}, fmt.Errorf("connect payload %d exceeds limit %d", length, maxPayload)
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(r, payload); err != nil {
		return ConnectFrame{}, fmt.Errorf("read connect payload: %w", err)
	}
	return ConnectFrame{Flags: header[0], Payload: payload}, nil
}

type ConnectEndStreamError struct{ Code, Message string }

func (e *ConnectEndStreamError) Error() string {
	return fmt.Sprintf("Cursor Connect error %s: %s", firstNonEmpty(e.Code, "unknown"), firstNonEmpty(e.Message, "unknown error"))
}

func ParseEndStreamTrailer(payload []byte) error {
	var trailer struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &trailer); err != nil {
		return fmt.Errorf("invalid Cursor Connect end-stream trailer: %w", err)
	}
	if trailer.Error == nil {
		return nil
	}
	return &ConnectEndStreamError{Code: trailer.Error.Code, Message: trailer.Error.Message}
}
