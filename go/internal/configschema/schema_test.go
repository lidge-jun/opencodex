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
