package server

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"io"
	"net/http/httptest"
	"testing"
)

func TestDecompressRequest(t *testing.T) {
	for _, tc := range []struct {
		name     string
		encoding string
		write    func(*bytes.Buffer) io.WriteCloser
	}{
		{"gzip", "gzip", func(b *bytes.Buffer) io.WriteCloser { return gzip.NewWriter(b) }},
		{"deflate", "deflate", func(b *bytes.Buffer) io.WriteCloser { return zlib.NewWriter(b) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var compressed bytes.Buffer
			writer := tc.write(&compressed)
			_, _ = writer.Write([]byte(`{"ok":true}`))
			_ = writer.Close()
			request := httptest.NewRequest("POST", "/", &compressed)
			request.Header.Set("Content-Encoding", tc.encoding)
			if err := DecompressRequest(request, 1024); err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != `{"ok":true}` {
				t.Fatalf("body = %q", got)
			}
		})
	}
}
