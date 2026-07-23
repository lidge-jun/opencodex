package protocol

import (
	"bufio"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
)

// SSEEvent is one dispatched server-sent event.
type SSEEvent struct {
	Event string
	Data  string
	ID    string
	Retry int
}

// SSEDecoder incrementally decodes a text/event-stream written in arbitrary chunks.
type SSEDecoder struct {
	pipeW  *io.PipeWriter
	done   chan struct{}
	mu     sync.Mutex
	err    error
	closed bool
}

// NewSSEDecoder creates a decoder that sends complete events to events.
// The caller owns and closes the events channel.
func NewSSEDecoder(events chan<- SSEEvent) *SSEDecoder {
	pipeR, pipeW := io.Pipe()
	d := &SSEDecoder{pipeW: pipeW, done: make(chan struct{})}
	go d.decode(pipeR, events)
	return d
}

// Write supplies another chunk of event-stream bytes.
func (d *SSEDecoder) Write(p []byte) (int, error) {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return 0, io.ErrClosedPipe
	}
	return d.pipeW.Write(p)
}

// Close flushes a final unterminated event and waits for decoding to finish.
func (d *SSEDecoder) Close() error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		<-d.done
		return d.result()
	}
	d.closed = true
	d.mu.Unlock()

	closeErr := d.pipeW.Close()
	<-d.done
	if err := d.result(); err != nil {
		return err
	}
	return closeErr
}

func (d *SSEDecoder) result() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.err
}

func (d *SSEDecoder) decode(r io.ReadCloser, events chan<- SSEEvent) {
	defer close(d.done)
	defer r.Close()

	reader := bufio.NewReader(r)
	state := sseState{}
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			terminated := line[len(line)-1] == '\n'
			if terminated {
				line = strings.TrimSuffix(line, "\n")
			}
			state.acceptLine(strings.TrimSuffix(line, "\r"), events)
		}
		if err == nil {
			continue
		}
		if errors.Is(err, io.EOF) {
			state.dispatch(events)
			return
		}
		d.mu.Lock()
		d.err = err
		d.mu.Unlock()
		return
	}
}

type sseState struct {
	event     string
	dataLines []string
	id        string
	retry     int
}

func (s *sseState) acceptLine(line string, events chan<- SSEEvent) {
	if line == "" {
		s.dispatch(events)
		return
	}
	if strings.HasPrefix(line, ":") {
		return
	}

	field, value, found := strings.Cut(line, ":")
	if !found {
		value = ""
	} else {
		value = strings.TrimPrefix(value, " ")
	}
	switch field {
	case "event":
		s.event = value
	case "data":
		s.dataLines = append(s.dataLines, value)
	case "id":
		if !strings.ContainsRune(value, '\x00') {
			s.id = value
		}
	case "retry":
		if n, err := strconv.Atoi(value); err == nil && n >= 0 {
			s.retry = n
		}
	}
}

func (s *sseState) dispatch(events chan<- SSEEvent) {
	if len(s.dataLines) == 0 {
		s.event = ""
		return
	}
	events <- SSEEvent{
		Event: s.event,
		Data:  strings.Join(s.dataLines, "\n"),
		ID:    s.id,
		Retry: s.retry,
	}
	s.event = ""
	s.dataLines = s.dataLines[:0]
}
