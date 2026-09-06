package configschema

import (
	"strings"
	"testing"
)

func TestNormalizeInjectsDefaultsInTypeScriptSchemaOrder(t *testing.T) {
	normalized, err := NormalizeJSON([]byte(`{"providers":{"acme":{"baseUrl":"https://api.example/v1","adapter":"openai-chat"}},"unknownFuture":true}`))
	if err != nil {
		t.Fatalf("NormalizeJSON: %v", err)
	}
	got, err := normalized.IndentedJSON()
	if err != nil {
		t.Fatalf("IndentedJSON: %v", err)
	}
	want := "{\n  \"port\": 10100,\n  \"managementUsageMaxReadBytes\": 67108864,\n  \"appOwnedMemoryBudgetMb\": 256,\n  \"providers\": {\n    \"acme\": {\n      \"adapter\": \"openai-chat\",\n      \"baseUrl\": \"https://api.example/v1\"\n    }\n  },\n  \"defaultProvider\": \"openai\",\n  \"unknownFuture\": true\n}"
	if string(got) != want {
		t.Fatalf("normalized JSON mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestValidateCandidatePortErrorsMatchTypeScript(t *testing.T) {
	_, err := ValidateCandidateJSON([]byte(`{"port":-1,"providers":{}}`))
	if err == nil {
		t.Fatal("ValidateCandidateJSON unexpectedly succeeded")
	}
	const want = "schema_invalid: port: Too small: expected number to be >=0"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err, want)
	}
}

func TestValidateCandidateChecksProviderMap(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"providers must be object", `{"providers":[]}`, "schema_invalid: providers: Invalid input: expected record, received array"},
		{"provider adapter required", `{"providers":{"x":{"baseUrl":"https://x"}}}`, "schema_invalid: providers.x.adapter: Invalid input: expected string, received undefined"},
		{"provider base URL required", `{"providers":{"x":{"adapter":"openai-chat"}}}`, "schema_invalid: providers.x.baseUrl: Invalid input: expected string, received undefined"},
		{"default provider nonblank", `{"providers":{},"defaultProvider":""}`, "schema_invalid: defaultProvider: Too small: expected string to have >=1 characters"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateCandidateJSON([]byte(tc.raw))
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestNormalizeDropsLoadTimeDegradedOptionals(t *testing.T) {
	normalized, err := NormalizeJSON([]byte(`{"hostname":"   ","appOwnedMemoryBudgetMb":-1,"upstreamHostCircuitThreshold":-1,"providers":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	compact, err := normalized.CompactJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"hostname", "upstreamHostCircuitThreshold"} {
		if strings.Contains(string(compact), forbidden) {
			t.Fatalf("%s survived load normalizer: %s", forbidden, compact)
		}
	}
	if !strings.Contains(string(compact), `"appOwnedMemoryBudgetMb":256`) {
		t.Fatalf("app default missing: %s", compact)
	}
}

func TestRedactedProjectionDropsSecretAndInvalidModelCostsRows(t *testing.T) {
	normalized, err := NormalizeJSON([]byte(`{
  "providers": {
    "example": {
      "adapter": "openai-chat",
      "baseUrl": "https://example.test",
      "modelCosts": {
        "gpt-safe": {"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 3, "ignored": "not displayed"},
        "sk-abcdef1234567890": {"input": 99, "output": 99, "cacheRead": 99, "cacheWrite": 99},
        "bad-rate": {"input": 1, "output": 2, "cacheRead": 0}
      }
    }
  }
}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := normalized.RedactedIndentedJSON()
	if err != nil {
		t.Fatal(err)
	}
	text := string(got)
	for _, leaked := range []string{"sk-abcdef1234567890", "99", "bad-rate", "ignored"} {
		if strings.Contains(text, leaked) {
			t.Fatalf("redacted config leaked %q: %s", leaked, text)
		}
	}
	if !strings.Contains(text, `"gpt-safe": {`) || !strings.Contains(text, `"cacheWrite": 3`) {
		t.Fatalf("valid display tuple missing: %s", text)
	}
}

func TestRedactedProjectionOmitsEmptyModelCosts(t *testing.T) {
	normalized, err := NormalizeJSON([]byte(`{"providers":{"example":{"adapter":"openai-chat","baseUrl":"https://example.test","modelCosts":{"sk-abcdef1234567890":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := normalized.RedactedIndentedJSON()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "modelCosts") {
		t.Fatalf("empty sanitized modelCosts must be omitted: %s", got)
	}
}

func TestSetCodexAccountPrioritiesClearsManualPin(t *testing.T) {
	normalized, err := NormalizeJSON([]byte(`{"providers":{},"activeCodexAccountPinned":"acct-1","codexAccountPriorities":{"acct-1":7}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !normalized.ClearCodexAccountPinForSet("codexAccountPriorities.acct-1") {
		t.Fatal("priority set did not clear manual pin")
	}
	got, err := normalized.CompactJSON()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "activeCodexAccountPinned") {
		t.Fatalf("manual pin survived priority update: %s", got)
	}
	other, err := NormalizeJSON([]byte(`{"providers":{},"activeCodexAccountPinned":"acct-2"}`))
	if err != nil {
		t.Fatal(err)
	}
	if other.ClearCodexAccountPinForSet("providers.example.adapter") {
		t.Fatal("unrelated config set cleared a pin")
	}
	otherJSON, err := other.CompactJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(otherJSON), "activeCodexAccountPinned") {
		t.Fatalf("unrelated config set removed pin: %s", otherJSON)
	}
}

func TestStrictWriteSchemaRejectsLoadDegradedFields(t *testing.T) {
	cases := []struct{ raw, want string }{
		{`{"providers":{},"hostname":"   "}`, "schema_invalid: hostname: must be a nonblank bind address"},
		{`{"providers":{},"appOwnedMemoryBudgetMb":63}`, "schema_invalid: appOwnedMemoryBudgetMb: must be an integer from 64 to 4096"},
		{`{"providers":{},"googleAntigravityStaticCatalogVersion":3}`, "schema_invalid: googleAntigravityStaticCatalogVersion: must be 1, 2, or omitted"},
		{`{"providers":{},"activeCodexAccountPinned":123}`, "schema_invalid: activeCodexAccountPinned: must be an account id"},
	}
	for _, tc := range cases {
		_, err := ValidateCandidateJSON([]byte(tc.raw))
		if err == nil || err.Error() != tc.want {
			t.Fatalf("ValidateCandidateJSON(%s) = %v, want %q", tc.raw, err, tc.want)
		}
	}
}

func TestStrictWriteSchemaUsesVisionCommandVocabulary(t *testing.T) {
	for _, reasoning := range []string{"none", "minimal", "ultra"} {
		_, err := ValidateCandidateJSON([]byte(`{"providers":{},"visionSidecar":{"reasoning":"` + reasoning + `"}}`))
		const want = "schema_invalid: visionSidecar.reasoning: must be one of low, medium, high, xhigh, max"
		if err == nil || err.Error() != want {
			t.Fatalf("reasoning %q error = %v, want %q", reasoning, err, want)
		}
	}
}

func TestApplyConfigPathMutationUsesStrictSchemaAndPinHook(t *testing.T) {
	raw := []byte(`{"providers":{},"activeCodexAccountPinned":"acct-1","codexAccountPriorities":{"acct-1":1}}`)
	updated, saved, changed, err := ApplyConfigPathMutation(raw, "codexAccountPriorities.acct-1", "2", false)
	if err != nil || !changed {
		t.Fatalf("mutation = %v, changed=%t", err, changed)
	}
	savedJSON, _ := saved.CompactJSON()
	if string(savedJSON) != "2" {
		t.Fatalf("saved value = %s", savedJSON)
	}
	updatedJSON, _ := updated.CompactJSON()
	if strings.Contains(string(updatedJSON), "activeCodexAccountPinned") {
		t.Fatalf("set retained pin: %s", updatedJSON)
	}
	_, _, _, err = ApplyConfigPathMutation(raw, "hostname", `" "`, false)
	if err == nil || err.Error() != "schema_invalid: hostname: must be a nonblank bind address" {
		t.Fatalf("strict mutation error = %v", err)
	}
}

// These examples were taken from direct calls to TypeScript's
// validateConfigCandidate. Keep the write boundary strict even where the
// config loader deliberately degrades malformed optional fields.
func TestStrictWriteSchemaRuntimeAndRemoteClientBoundaries(t *testing.T) {
	validClient := `{"serverUrl":"https://hub.example.test","managementUrl":"https://manage.example.test","managementTransport":"direct","selectedClients":["codex","claude"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":"issued-key-id","tokenFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"connectedAt":"2026-08-28T00:00:00.000Z"}`
	cases := []struct{ name, raw, want string }{
		{"bad role", `{"providers":{},"runtimeRole":"server"}`, "schema_invalid: runtimeRole: must be one of \"standalone\", \"hub\", or \"client\""},
		{"client role needs connection", `{"providers":{},"runtimeRole":"client"}`, "schema_invalid: runtimeRole client requires a complete client connection"},
		{"connection needs client role", `{"providers":{},"client":` + validClient + `}`, "schema_invalid: client connection requires runtimeRole client"},
		{"duplicate selected client", `{"providers":{},"runtimeRole":"client","client":{"serverUrl":"https://hub.example.test","managementUrl":"https://manage.example.test","managementTransport":"direct","selectedClients":["codex","codex"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":"issued-key-id","tokenFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"connectedAt":"2026-08-28T00:00:00.000Z"}}`, "schema_invalid: client.selectedClients: must contain unique client ids"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateCandidateJSON([]byte(tc.raw))
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
	if _, err := ValidateCandidateJSON([]byte(`{"providers":{},"runtimeRole":"client","client":` + validClient + `}`)); err != nil {
		t.Fatalf("valid client rejected: %v", err)
	}
}

func TestStrictWriteSchemaHubAndRemoteGUIBoundaries(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"unsafe hub origin", `{"providers":{},"hub":{"managementPublicOrigin":"https://user@hub.example.test"}}`, "schema_invalid: hub.managementPublicOrigin: must be a canonical http(s) origin without credentials, path, query, or fragment"},
		{"duplicate tailscale users", `{"providers":{},"remoteGui":{"allowedTailscaleUsers":[" alice@example.test ","alice@example.test"]}}`, "schema_invalid: remoteGui.allowedTailscaleUsers.1: must contain unique users after trimming"},
		{"unknown hub property", `{"providers":{},"hub":{"unexpected":true}}`, "schema_invalid: hub: Unrecognized key: \"unexpected\""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateCandidateJSON([]byte(tc.raw))
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
	if _, err := ValidateCandidateJSON([]byte(`{"providers":{},"hub":{"managementPublicOrigin":"https://hub.example.test:443"},"remoteGui":{"allowedTailscaleUsers":[" alice@example.test "]}}`)); err != nil {
		t.Fatalf("valid hub/remote GUI rejected: %v", err)
	}
}

func TestStrictWriteSchemaCodexAccountMaps(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"priority record", `{"providers":{},"codexAccountPriorities":[]}`, "schema_invalid: codexAccountPriorities.config: codexAccountPriorities must be a plain object mapping Codex account ids to selection-order integers"},
		{"priority key", `{"providers":{},"codexAccountPriorities":{"bad id!":1}}`, "schema_invalid: codexAccountPriorities.bad id!: selection-order keys must be a Codex pool-account id or the main Codex account and cannot be reserved JavaScript object keys"},
		{"priority value", `{"providers":{},"codexAccountPriorities":{"work":101}}`, "schema_invalid: codexAccountPriorities.work: selection order must be an integer between -100 and 100"},
		{"namespace record", `{"providers":{},"codexAccountNamespaces":[]}`, "schema_invalid: codexAccountNamespaces: codexAccountNamespaces must be a plain object mapping account selectors to Codex account ids"},
		{"namespace target", `{"providers":{},"codexAccountNamespaces":{"work":"?"}}`, "schema_invalid: codexAccountNamespaces.work: account selector targets must be @main or valid Codex pool-account ids"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateCandidateJSON([]byte(tc.raw))
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
	if _, err := ValidateCandidateJSON([]byte(`{"providers":{},"codexAccountPriorities":{"__main__":-100,"work":100},"codexAccountNamespaces":{"work":"side-acct","main":"@main"}}`)); err != nil {
		t.Fatalf("valid account maps rejected: %v", err)
	}
}

func TestStrictWriteSchemaIngressAndRecoveryBoundaries(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"recovery strict property", `{"providers":{},"agentTaskRecovery":{"url":"https://attacker.example"}}`, "schema_invalid: agentTaskRecovery: Unrecognized key: \"url\""},
		{"recovery timeout", `{"providers":{},"agentTaskRecovery":{"timeoutMs":999}}`, "schema_invalid: agentTaskRecovery.timeoutMs: Too small: expected number to be >=1000"},
		{"loopback disabled shape", `{"providers":{},"unauthenticatedLoopbackListener":{"enabled":false,"port":1}}`, "schema_invalid: unauthenticatedLoopbackListener: Unrecognized key: \"port\""},
		{"loopback collision", `{"providers":{},"port":1234,"unauthenticatedLoopbackListener":{"enabled":true,"port":1234}}`, "schema_invalid: unauthenticatedLoopbackListener.port: must differ from the proxy port"},
		{"ingress needs hub", `{"providers":{},"hub":{"managementIngress":{"enabled":true,"port":1235}}}`, "schema_invalid: hub.managementIngress: enabled ingress requires runtimeRole hub"},
		{"ingress loopback collision", `{"providers":{},"runtimeRole":"hub","unauthenticatedLoopbackListener":{"enabled":true,"port":1235},"hub":{"managementIngress":{"enabled":true,"port":1235}}}`, "schema_invalid: hub.managementIngress.port: must differ from unauthenticatedLoopbackListener.port"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateCandidateJSON([]byte(tc.raw))
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
	if _, err := ValidateCandidateJSON([]byte(`{"providers":{},"runtimeRole":"hub","hub":{"managementIngress":{"enabled":true,"port":1235}},"agentTaskRecovery":{"enabled":true,"model":"gpt-5.6-sol","timeoutMs":1000,"cacheEntries":512}}`)); err != nil {
		t.Fatalf("valid ingress/recovery rejected: %v", err)
	}
}

func TestStrictWriteSchemaNormalizesAcceptedRemoteValues(t *testing.T) {
	normalized, err := ValidateCandidateJSON([]byte(
		`{"providers":{},"hub":{"managementPublicOrigin":"https://HUB.example.test:443/"},"remoteGui":{"allowedTailscaleUsers":[" alice@example.test "]},"agentTaskRecovery":{"model":" gpt-5.6-sol "},"runtimeRole":"client","client":{"serverUrl":"https://HUB.example.test:443/","managementUrl":"http://manage.example.test:80/","managementTransport":"direct","selectedClients":["codex"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":" issued-key-id ","tokenFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"connectedAt":"2026-08-28T00:00:00.000Z"}}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	got, err := normalized.CompactJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"managementPublicOrigin":"https://hub.example.test"`, `"allowedTailscaleUsers":["alice@example.test"]`, `"model":"gpt-5.6-sol"`, `"serverUrl":"https://hub.example.test"`, `"managementUrl":"http://manage.example.test"`, `"apiKeyId":"issued-key-id"`} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("normalized output %s does not contain %s", got, want)
		}
	}
}

func TestStrictWriteSchemaAccountNamespaceCollisionsAndClientState(t *testing.T) {
	t.Setenv("OPENCODEX_HOME", "/tmp/ocx37-home")
	cases := []struct{ name, raw, want string }{
		{"namespace provider collision", `{"providers":{"work":{"adapter":"openai-chat","baseUrl":"https://example.test"}},"codexAccountNamespaces":{"work":"side-acct"}}`, "schema_invalid: codexAccountNamespaces.work: account selectors must not collide with configured provider, combo, or routing policy namespaces"},
		{"namespace target collision", `{"providers":{},"codexAccountNamespaces":{"first":"same-account","same-account":"@main"}}`, "schema_invalid: codexAccountNamespaces.first: account selectors must not collide with configured Codex pool-account ids or account selector targets"},
		{"duplicate targets allowed", `{"providers":{},"codexAccountNamespaces":{"first":"same-account","second":"same-account"}}`, ""},
		{"client optional timestamp", `{"providers":{},"runtimeRole":"client","client":{"serverUrl":"https://hub.example.test","managementUrl":"https://manage.example.test","managementTransport":"direct","selectedClients":["codex"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":"issued-key-id","tokenFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"connectedAt":"2026-08-28T00:00:00.000Z","catalogSyncedAt":"bad"}}`, "schema_invalid: client.catalogSyncedAt: Invalid ISO datetime"},
		{"client pending state strict", `{"providers":{},"runtimeRole":"client","client":{"serverUrl":"https://hub.example.test","managementUrl":"https://manage.example.test","managementTransport":"direct","selectedClients":["codex"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":"issued-key-id","tokenFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"connectedAt":"2026-08-28T00:00:00.000Z","pendingOperation":{"kind":"rotate","rotationId":"r","newKeyIssuedAt":"2026-08-28T00:00:00.000Z","oldKeyBackupPath":"/tmp/previous","extra":true}}}`, "schema_invalid: client.pendingOperation: Unrecognized key: \"extra\""},
		{"client pending state path", `{"providers":{},"runtimeRole":"client","client":{"serverUrl":"https://hub.example.test","managementUrl":"https://manage.example.test","managementTransport":"direct","selectedClients":["codex"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":"issued-key-id","tokenFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"connectedAt":"2026-08-28T00:00:00.000Z","pendingOperation":{"kind":"rotate","rotationId":"r","newKeyIssuedAt":"2026-08-28T00:00:00.000Z","oldKeyBackupPath":"/tmp/foreign"}}}`, "schema_invalid: client.pendingOperation.oldKeyBackupPath: must equal /tmp/ocx37-home/service-api-token.prev"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateCandidateJSON([]byte(tc.raw))
			if tc.want == "" {
				if err != nil {
					t.Fatalf("error = %v, want success", err)
				}
				return
			}
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}
