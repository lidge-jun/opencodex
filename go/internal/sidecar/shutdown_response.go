package sidecar

import "net/http"

// writeDrainingResponse matches the TypeScript drainingResponse contract:
// 503 JSON server_error, a stable message, and a five-second retry hint.
func writeDrainingResponse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "5")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`{"error":{"message":"Service shutting down","type":"server_error","code":"server_is_overloaded"}}`))
}
