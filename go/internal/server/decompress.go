package server

import (
	"compress/gzip"
	"compress/zlib"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const MaxDecompressedBodyBytes int64 = 256 << 20

// DecompressRequest replaces a gzip or zlib-deflate request body with a bounded decoded stream.
func DecompressRequest(r *http.Request, maxBytes int64) error {
	if maxBytes <= 0 {
		maxBytes = MaxDecompressedBodyBytes
	}
	encoding := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding")))
	if encoding == "" || encoding == "identity" {
		r.Body = &limitedBody{Reader: io.LimitReader(r.Body, maxBytes+1), closer: r.Body, max: maxBytes}
		return nil
	}
	compressed := r.Body
	var reader io.ReadCloser
	var err error
	switch encoding {
	case "gzip", "x-gzip":
		reader, err = gzip.NewReader(compressed)
	case "deflate":
		reader, err = zlib.NewReader(compressed)
	default:
		return fmt.Errorf("unsupported content-encoding %q", encoding)
	}
	if err != nil {
		_ = compressed.Close()
		return fmt.Errorf("decode %s request: %w", encoding, err)
	}
	r.Body = &compoundBody{Reader: &limitErrorReader{reader: reader, remaining: maxBytes}, closers: []io.Closer{reader, compressed}}
	r.Header.Del("Content-Encoding")
	r.ContentLength = -1
	return nil
}

type limitErrorReader struct {
	reader    io.Reader
	remaining int64
}

func (r *limitErrorReader) Read(p []byte) (int, error) {
	if r.remaining < 0 {
		return 0, fmt.Errorf("decompressed request body exceeds limit")
	}
	if int64(len(p)) > r.remaining+1 {
		p = p[:r.remaining+1]
	}
	n, err := r.reader.Read(p)
	r.remaining -= int64(n)
	if r.remaining < 0 {
		return n, fmt.Errorf("decompressed request body exceeds limit")
	}
	return n, err
}

type compoundBody struct {
	io.Reader
	closers []io.Closer
}

func (b *compoundBody) Close() error {
	var first error
	for _, c := range b.closers {
		if err := c.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

type limitedBody struct {
	io.Reader
	closer io.Closer
	max    int64
	read   int64
}

func (b *limitedBody) Read(p []byte) (int, error) {
	n, err := b.Reader.Read(p)
	b.read += int64(n)
	if b.read > b.max {
		return n, fmt.Errorf("request body exceeds limit")
	}
	return n, err
}
func (b *limitedBody) Close() error { return b.closer.Close() }

func decompressionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := DecompressRequest(r, MaxDecompressedBodyBytes); err != nil {
			http.Error(w, err.Error(), http.StatusUnsupportedMediaType)
			return
		}
		next.ServeHTTP(w, r)
	})
}
