package main

// The authcheck subcommand is the differential-oracle entry point for the Go
// management auth model (ADR-0008, ticket #18): it evaluates one or more
// admission vectors in a single process — so the per-capability replay stores
// behave exactly like the TS module-level maps — and prints the decisions as
// JSON. tests/go-auth-parity.test.ts feeds the same vector arrays through
// src/server/management-auth.ts and through this subcommand and compares the
// outputs byte for byte. The subcommand is inert on the live path: ocx-sidecar
// runs it only when invoked as `ocx-sidecar authcheck`, which the supervisor
// never does.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

// authVector mirrors the request/state/config/local slice the oracle test
// builds from the TypeScript side.
type authVector struct {
	Request authRequest `json:"request"`
	State   authState   `json:"state"`
	Config  authConfig  `json:"config"`
	Local   authLocal   `json:"local"`
	Probe   bool        `json:"sessionProbe,omitempty"`
}

type authRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
}

type authSessionEntry struct {
	Token         string `json:"token"`
	ServerOrigin  string `json:"serverOrigin"`
	BrowserOrigin string `json:"browserOrigin"`
	CSRF          string `json:"csrf"`
	ExpiresAt     int64  `json:"expiresAt"`
	Issuance      string `json:"issuance"`
}

type authState struct {
	Available bool               `json:"available"`
	Token     string             `json:"token"`
	Source    string             `json:"source"`
	Reason    string             `json:"reason"`
	Sessions  []authSessionEntry `json:"sessions"`
}

type authConfig struct {
	Hostname                  string `json:"hostname"`
	RuntimeRole               string `json:"runtimeRole"`
	HubManagementPublicOrigin string `json:"hubManagementPublicOrigin"`
}

type authLocal struct {
	AttestationSecret string `json:"attestationSecret"`
	PID               int    `json:"pid"`
	Port              int    `json:"port"`
}

type authDecision struct {
	Admitted     bool           `json:"admitted"`
	Principal    *string        `json:"principal"`
	Rejection    *authRejection `json:"rejection"`
	SessionState string         `json:"sessionState,omitempty"`
}

type authRejection struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

func runAuthCheck() error {
	// The vectors arrive as a JSON argv element (the oracle test passes them on
	// the command line so Bun.spawnSync can stay synchronous); stdin is the
	// fallback for direct shell use.
	var raw []byte
	if len(os.Args) > 2 {
		raw = []byte(os.Args[2])
	} else {
		var err error
		raw, err = io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("authcheck: read stdin: %w", err)
		}
	}
	var vectors []authVector
	if err := json.Unmarshal(raw, &vectors); err != nil {
		return fmt.Errorf("authcheck: decode vectors: %w", err)
	}

	// One gate per invocation, mirroring one serving process. All vectors share
	// it so capability consumption persists across the array exactly as the TS
	// module-level stores do within one oracle run.
	gate := buildGate(vectors)
	decisions := make([]authDecision, 0, len(vectors))
	for _, vector := range vectors {
		req := managementauth.Request{
			URL:    vector.Request.URL,
			Method: vector.Request.Method,
			Header: lowerHeaders(vector.Request.Headers),
		}
		decision := gate.Admit(&req)
		out := authDecision{}
		if decision.Principal != "" {
			out.Admitted = true
			principal := string(decision.Principal)
			out.Principal = &principal
		} else {
			out.Rejection = &authRejection{Status: decision.Rejection.Status, Body: decision.Rejection.Body}
		}
		if vector.Probe {
			sessionState := "missing"
			if admission := managementauth.AuthorizeSession(
				&req,
				vectorConfig(vector),
				sessionsCopy(gateState(gate)),
				time.Now().UnixMilli(),
			); admission.OK {
				sessionState = "ok"
			} else {
				sessionState = string(admission.Reason)
			}
			out.SessionState = sessionState
		}
		decisions = append(decisions, out)
	}
	encoded, err := json.Marshal(decisions)
	if err != nil {
		return fmt.Errorf("authcheck: encode decisions: %w", err)
	}
	fmt.Println(string(encoded))
	return nil
}

func lowerHeaders(headers map[string]string) map[string]string {
	if headers == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(headers))
	for name, value := range headers {
		out[strings.ToLower(name)] = value
	}
	return out
}

func vectorConfig(vector authVector) managementauth.ConfigView {
	return managementauth.ConfigView{
		Hostname:                  vector.Config.Hostname,
		RuntimeRole:               vector.Config.RuntimeRole,
		HubManagementPublicOrigin: vector.Config.HubManagementPublicOrigin,
	}
}

func buildGate(vectors []authVector) *managementauth.Gate {
	if len(vectors) == 0 {
		return managementauth.NewGate(managementauth.State{Available: false, Reason: ""}, managementauth.ConfigView{}, managementauth.LocalContext{})
	}
	first := vectors[0]
	state := managementauth.State{
		Available: first.State.Available,
		Token:     first.State.Token,
		Source:    first.State.Source,
		Reason:    first.State.Reason,
		Sessions:  map[string]managementauth.Session{},
	}
	for _, entry := range first.State.Sessions {
		state.Sessions[entry.Token] = managementauth.Session{
			ServerOrigin:  entry.ServerOrigin,
			BrowserOrigin: entry.BrowserOrigin,
			CSRF:          entry.CSRF,
			ExpiresAt:     entry.ExpiresAt,
			Issuance:      entry.Issuance,
		}
	}
	return managementauth.NewGate(state, vectorConfig(first), managementauth.LocalContext{
		AttestationSecret: first.Local.AttestationSecret,
		PID:               first.Local.PID,
		Port:              first.Local.Port,
	})
}

func gateState(gate *managementauth.Gate) map[string]managementauth.Session {
	return gate.Sessions()
}

func sessionsCopy(sessions map[string]managementauth.Session) map[string]managementauth.Session {
	out := make(map[string]managementauth.Session, len(sessions))
	for token, session := range sessions {
		out[token] = session
	}
	return out
}
