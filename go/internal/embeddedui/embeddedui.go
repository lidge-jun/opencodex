// Package embeddedui serves the dashboard for the standalone ocx runtime.
//
// Resolution order mirrors the TypeScript runtime (src/server/gui-static.ts
// findGuiDist): a live dashboard build under <repo>/gui/dist is served when the
// binary runs from a checkout or a packaged tree that carries it; otherwise the
// binary falls back to the small static page embedded below.
//
// static/ carries hand-written source assets only (the thin fallback page and
// the provider-icon set mirrored from gui/public). Generated Vite build output
// is never checked in here — it must not enter git history (the repository
// ignores gui/dist for the same reason) — so a checkout's gui/dist, refreshed
// by the release build, is read from disk instead.
package embeddedui

import (
	"bytes"
	"embed"
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

//go:embed static
var files embed.FS

// Handler serves the dashboard HTTP surface. The caller supplies its version
// because release builds stamp it with ldflags.
type Handler struct {
	version string
	// findDist returns the absolute path of a live dashboard build to serve, or
	// "" when the embedded fallback should be used. nil means the default
	// resolver (an upward search from the working directory for gui/dist).
	findDist func() string
}

// NewHandler returns the complete dashboard HTTP surface. The caller supplies
// its version because release builds stamp it with ldflags.
func NewHandler(version string) *Handler {
	return &Handler{version: version}
}

// NewHandlerWithResolver is NewHandler with an explicit dashboard-build
// resolver; tests use it to point at a synthetic build without touching the
// working directory.
func NewHandlerWithResolver(version string, findDist func() string) *Handler {
	return &Handler{version: version, findDist: findDist}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/healthz" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok", "service": "opencodex", "version": h.version,
			"uptime": 0, "pid": 0, "port": 0,
		})
		return
	}
	if dist := h.dashboardDir(); dist != "" && serveFrom(dist, w, r) {
		return
	}
	serveEmbedded(w, r)
}

// dashboardDir resolves the runtime dashboard build to serve, if any.
func (h *Handler) dashboardDir() string {
	if h.findDist != nil {
		return h.findDist()
	}
	return findGuiDist()
}

// findGuiDist walks upward from the working directory looking for a gui/dist
// with an index.html, mirroring findGuiDist() in src/server/gui-static.ts. A
// release binary executed from a packaged install finds nothing and falls back
// to the embedded page.
func findGuiDist() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		candidate := filepath.Join(dir, "gui", "dist")
		if info, statErr := os.Stat(filepath.Join(candidate, "index.html")); statErr == nil && !info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// serveFrom serves one file from a live dashboard build directory. It reports
// whether the request was fully handled (a file existed, or an extensionless
// path resolved to the build's index.html).
func serveFrom(dist string, w http.ResponseWriter, r *http.Request) bool {
	name, spa := embeddedName(r.URL.Path)
	if name == "" {
		http.NotFound(w, r)
		return true
	}
	body, err := os.ReadFile(filepath.Join(dist, filepath.FromSlash(name)))
	if err != nil && spa {
		body, err = os.ReadFile(filepath.Join(dist, "index.html"))
		if err == nil {
			name = "index.html"
		}
	}
	if err != nil {
		if os.IsNotExist(err) {
			return false
		}
		http.NotFound(w, r)
		return true
	}
	serveBytes(w, r, name, body)
	return true
}

func serveEmbedded(w http.ResponseWriter, r *http.Request) {
	name, spa := embeddedName(r.URL.Path)
	if name == "" {
		http.NotFound(w, r)
		return
	}
	body, err := fs.ReadFile(files, path.Join("static", name))
	if err != nil && spa {
		name, body, err = "index.html", nil, nil
		body, err = fs.ReadFile(files, path.Join("static", name))
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	serveBytes(w, r, name, body)
}

func serveBytes(w http.ResponseWriter, r *http.Request, name string, body []byte) {
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
}

func embeddedName(requestPath string) (name string, spa bool) {
	// Path traversal must be refused on the RAW path: path.Clean collapses
	// "/provider-icons/../x" to "/x" before any ".." check can see it, and the
	// join with the embed or dist root happens after this guard. Both the
	// literal form and the URL-encoded form are rejected by net/http before a
	// request reaches a handler (r.URL.Path is decoded), so checking the
	// decoded path here is sufficient.
	if strings.Contains(requestPath, "\\") || strings.Contains(requestPath, "..") {
		return "", false
	}
	cleaned := path.Clean("/" + requestPath)
	name = strings.TrimPrefix(cleaned, "/")
	if name == "" {
		return "index.html", false
	}
	return name, path.Ext(name) == ""
}
