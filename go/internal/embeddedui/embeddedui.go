// Package embeddedui serves the dashboard baked into a release ocx binary.
//
// static is checked in as the release snapshot. scripts/build-go-release-artifact.sh
// refreshes it from gui/dist before a release build. Keeping a snapshot in-tree
// is intentional: go build must remain deterministic and usable by contributors
// and CI that do not have Bun or the GUI dependency tree installed.
package embeddedui

import (
	"bytes"
	"embed"
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed static
var files embed.FS

// NewHandler returns the complete self-contained dashboard HTTP surface. The
// caller supplies its version because release builds stamp it with ldflags.
func NewHandler(version string) http.Handler {
	root, err := fs.Sub(files, "static")
	if err != nil {
		panic(err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok", "service": "opencodex", "version": version,
				"uptime": 0, "pid": 0, "port": 0,
			})
			return
		}
		name, spa := embeddedName(r.URL.Path)
		if name == "" {
			http.NotFound(w, r)
			return
		}
		body, err := fs.ReadFile(root, name)
		if err != nil && spa {
			name, body, err = "index.html", nil, nil
			body, err = fs.ReadFile(root, name)
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		contentType := mime.TypeByExtension(path.Ext(name))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		if strings.HasSuffix(name, ".html") {
			contentType = "text/html; charset=utf-8"
		}
		w.Header().Set("Content-Type", contentType)
		if strings.HasSuffix(name, ".html") {
			w.Header().Set("Cache-Control", "no-store")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodHead {
			return
		}
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body))
	})
}

func embeddedName(requestPath string) (name string, spa bool) {
	cleaned := path.Clean("/" + requestPath)
	if strings.Contains(requestPath, "\\") || strings.Contains(cleaned, "..") {
		return "", false
	}
	name = strings.TrimPrefix(cleaned, "/")
	if name == "" {
		return "index.html", false
	}
	return name, path.Ext(name) == ""
}
