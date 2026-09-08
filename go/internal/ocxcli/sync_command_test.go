package ocxcli

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// syncTestEnv isolates one test from a developer's real ~/.opencodex and
// ~/.codex and registers K-namespace cleanup for the temp Codex home.
func syncTestEnv(t *testing.T) (openCodexHome, codexHome string) {
	t.Helper()
	openCodexHome = t.TempDir()
	codexHome = t.TempDir()
	t.Setenv("OPENCODEX_HOME", openCodexHome)
	t.Setenv("CODEX_HOME", codexHome)
	t.Cleanup(func() {
		if db, err := resolveCatalogWriteDatabasePath(codexHome); err == nil {
			_ = os.Remove(db)
		}
	})
	return openCodexHome, codexHome
}

func syncWriteConfig(t *testing.T, openCodexHome string, config string) {
	t.Helper()
	if config == "" {
		return
	}
	if err := os.WriteFile(filepath.Join(openCodexHome, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSyncHelpTextIsNativeAndMatchesRegistry(t *testing.T) {
	for _, argv := range [][]string{{"help", "sync"}, {"help", "sync-cache"}} {
		var out, errOut bytes.Buffer
		if code := Run(argv, depsFor(RuntimeState{}, &out, &errOut)); code != ExitOK {
			t.Fatalf("%v = %d", argv, code)
		}
		want := syncHelpText
		if argv[1] == "sync-cache" {
			want = syncCacheHelpText
		}
		if out.String() != want {
			t.Fatalf("%v stdout = %q, want %q", argv, out.String(), want)
		}
		if errOut.Len() != 0 {
			t.Fatalf("%v stderr = %q", argv, errOut.String())
		}
	}
}

const syncFixtureProvider = `"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"fixture-model","models":["fixture-model","second"],"contextWindow":128000}},"defaultProvider":"fixture"`

func syncConfigON() string { return "{" + syncFixtureProvider + "}" }
func syncConfigOFF() string {
	return "{" + syncFixtureProvider + `,"clientIntegrations":{"codex":false}}`
}

func TestRunSyncONMissingConfigTomlMatchesOracle(t *testing.T) {
	openHome, codexHome := syncTestEnv(t)
	syncWriteConfig(t, openHome, syncConfigON())
	var out, errOut bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &errOut)
	deps.Delegate = func(args []string) (int, error) {
		t.Fatalf("preflight-refused sync must not delegate: %v", args)
		return 0, nil
	}
	if code := Run([]string{"sync"}, deps); code != ExitFailure {
		t.Fatalf("sync = %d", code)
	}
	if want := "   Target Codex home: " + codexHome + "\n"; out.String() != want {
		t.Fatalf("stdout = %q, want %q", out.String(), want)
	}
	if want := "Codex config not found at " + codexHome + "/config.toml. Is Codex installed?\n" +
		"Codex sync did not complete. Fix the reported Codex config issue and retry.\n"; errOut.String() != want {
		t.Fatalf("stderr = %q, want %q", errOut.String(), want)
	}
}

func TestRunSyncOFFCustomMissingCatalogSkipsNatively(t *testing.T) {
	openHome, codexHome := syncTestEnv(t)
	syncWriteConfig(t, openHome, syncConfigOFF())
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"),
		[]byte("model_catalog_json = \"/nonexistent/custom-catalog.json\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &errOut)
	deps.Delegate = func(args []string) (int, error) {
		t.Fatalf("no-source catalog-only sync must not delegate: %v", args)
		return 0, nil
	}
	if code := Run([]string{"sync"}, deps); code != ExitOK {
		t.Fatalf("sync = %d stderr=%q", code, errOut.String())
	}
	if want := "Codex integration is OFF; catalog refresh skipped, Codex config untouched.\n"; out.String() != want {
		t.Fatalf("stdout = %q, want %q", out.String(), want)
	}
	if want := "catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog.\n"; errOut.String() != want {
		t.Fatalf("stderr = %q, want %q", errOut.String(), want)
	}
}

func TestRunSyncClientStateRefusals(t *testing.T) {
	cases := []struct {
		name    string
		config  string
		wantOut string
		wantErr string
		code    int
	}{
		{
			name:    "invalid role",
			config:  "{" + syncFixtureProvider + `,"runtimeRole":"weird"}`,
			wantErr: "Client state is invalid: config.json.runtimeRole is invalid\n",
			code:    ExitFailure,
		},
		{
			name:    "mismatched client",
			config:  "{" + syncFixtureProvider + `,"client":{"apiKeyId":"k"}}`,
			wantErr: "Client state is mismatched: config.json.client is present without runtimeRole=client\n",
			code:    ExitFailure,
		},
		{
			name:    "mismatched role",
			config:  "{" + syncFixtureProvider + `,"runtimeRole":"client"}`,
			wantErr: "Client state is mismatched: runtimeRole=client is present without config.json.client\n",
			code:    ExitFailure,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			openHome, _ := syncTestEnv(t)
			syncWriteConfig(t, openHome, tc.config)
			var out, errOut bytes.Buffer
			deps := depsFor(RuntimeState{}, &out, &errOut)
			deps.Delegate = func([]string) (int, error) { t.Fatal("refusal delegated"); return 0, nil }
			if code := Run([]string{"sync"}, deps); code != tc.code {
				t.Fatalf("sync = %d", code)
			}
			if errOut.String() != tc.wantErr {
				t.Fatalf("stderr = %q, want %q", errOut.String(), tc.wantErr)
			}
			if out.String() != tc.wantOut {
				t.Fatalf("stdout = %q, want %q", out.String(), tc.wantOut)
			}
		})
	}
}

func TestRunSyncDelegatesToTypeScriptForRefreshStates(t *testing.T) {
	// A readable catalog on the default path (or a present config.toml) means the
	// TS refresh engine owns the write; the Go runner must hand it the full argv.
	cases := []struct {
		name    string
		config  string
		prepare func(codexHome string)
	}{
		{name: "off default-path catalog", config: syncConfigOFF(), prepare: func(h string) {
			writeFileTest(t, filepath.Join(h, "opencodex-catalog.json"), `{"models":[{"slug":"m"}]}`)
		}},
		{name: "on config-toml present", config: syncConfigON(), prepare: func(h string) {
			writeFileTest(t, filepath.Join(h, "config.toml"), "")
		}},
		{name: "off custom-path catalog", config: syncConfigOFF(), prepare: func(h string) {
			writeFileTest(t, filepath.Join(h, "config.toml"), "model_catalog_json = \"/tmp/custom-cat.json\"\n")
			writeFileTest(t, "/tmp/custom-cat.json", `{"models":[{"slug":"m"}]}`)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			openHome, codexHome := syncTestEnv(t)
			syncWriteConfig(t, openHome, tc.config)
			tc.prepare(codexHome)
			var out, errOut bytes.Buffer
			deps := depsFor(RuntimeState{}, &out, &errOut)
			var got []string
			deps.Delegate = func(args []string) (int, error) {
				got = append([]string(nil), args...)
				return 7, nil
			}
			if code := Run([]string{"sync", "--restart-codex"}, deps); code != 7 {
				t.Fatalf("sync = %d, want delegated 7", code)
			}
			if len(got) != 2 || got[0] != "sync" || got[1] != "--restart-codex" {
				t.Fatalf("delegated argv = %#v, want [sync --restart-codex]", got)
			}
		})
	}
}

func writeFileTest(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

const cacheWrapperPrefix = `{
  "fetched_at": "2000-01-01T00:00:00Z",
  "client_version": "0.0.0",
  "models": [
    {
      "slug": "fixture-model",
      "display_name": "Fixture",
      "context_window": 128000
    }
  ]
}
`

func TestRunSyncCacheWritesByteIdenticalCache(t *testing.T) {
	openHome, codexHome := syncTestEnv(t)
	syncWriteConfig(t, openHome, syncConfigOFF())
	writeFileTest(t, filepath.Join(codexHome, "opencodex-catalog.json"),
		`{"models":[{"slug":"fixture-model","display_name":"Fixture","context_window":128000}]}`)
	var out, errOut bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &errOut)
	deps.Delegate = func([]string) (int, error) { t.Fatal("sync-cache delegated"); return 0, nil }
	if code := Run([]string{"sync-cache"}, deps); code != ExitOK {
		t.Fatalf("sync-cache = %d", code)
	}
	if out.String() != "" || errOut.String() != "" {
		t.Fatalf("wrote path must be silent: stdout=%q stderr=%q", out.String(), errOut.String())
	}
	raw, err := os.ReadFile(filepath.Join(codexHome, "models_cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != cacheWrapperPrefix {
		t.Fatalf("cache bytes = %q, want %q", string(raw), cacheWrapperPrefix)
	}
	info, err := os.Stat(filepath.Join(codexHome, "models_cache.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("cache mode = %v err=%v", info, err)
	}
}

func TestRunSyncCacheEnvelopesMatchTypeScript(t *testing.T) {
	// no catalog, human + json
	{
		openHome, _ := syncTestEnv(t)
		syncWriteConfig(t, openHome, syncConfigON())
		var out, errOut bytes.Buffer
		if code := Run([]string{"sync-cache"}, depsFor(RuntimeState{}, &out, &errOut)); code != ExitOK {
			t.Fatalf("code=%d", code)
		}
		if want := syncCacheNoCatalog + "\n"; out.String() != want {
			t.Fatalf("stdout = %q, want %q", out.String(), want)
		}
		if errOut.String() != "" {
			t.Fatalf("stderr = %q", errOut.String())
		}
	}
	{
		openHome, codexHome := syncTestEnv(t)
		syncWriteConfig(t, openHome, syncConfigON())
		var out, errOut bytes.Buffer
		if code := Run([]string{"sync-cache", "--json"}, depsFor(RuntimeState{}, &out, &errOut)); code != ExitOK {
			t.Fatalf("code=%d", code)
		}
		if want := "{\n  \"schemaVersion\": 1,\n  \"ok\": true,\n  \"wrote\": false,\n  \"skipped\": true,\n  \"outcome\": \"completed\",\n  \"skippedReason\": \"no_catalog\",\n  \"desiredDisabled\": false,\n  \"codexHome\": \"" + codexHome + "\"\n}\n"; out.String() != want {
			t.Fatalf("stdout = %q", out.String())
		}
		if errOut.String() != "" {
			t.Fatalf("stderr = %q", errOut.String())
		}
	}
	// OFF with no catalog prints the OFF line and the no-catalog line.
	{
		openHome, _ := syncTestEnv(t)
		syncWriteConfig(t, openHome, syncConfigOFF())
		var out, errOut bytes.Buffer
		if code := Run([]string{"sync-cache"}, depsFor(RuntimeState{}, &out, &errOut)); code != ExitOK {
			t.Fatalf("code=%d", code)
		}
		if want := syncCacheOffNoWrite + "\n" + syncCacheNoCatalog + "\n"; out.String() != want {
			t.Fatalf("stdout = %q, want %q", out.String(), want)
		}
	}
	// OFF with a readable catalog writes silently (allowWhenDesiredDisabled).
	{
		openHome, codexHome := syncTestEnv(t)
		syncWriteConfig(t, openHome, syncConfigOFF())
		writeFileTest(t, filepath.Join(codexHome, "opencodex-catalog.json"), `{"models":[{"slug":"m1"}]}`)
		var out, errOut bytes.Buffer
		if code := Run([]string{"sync-cache"}, depsFor(RuntimeState{}, &out, &errOut)); code != ExitOK {
			t.Fatalf("code=%d stderr=%q", code, errOut.String())
		}
		if out.String() != "" || errOut.String() != "" {
			t.Fatalf("stdout=%q stderr=%q", out.String(), errOut.String())
		}
		if !syncPathExists(filepath.Join(codexHome, "models_cache.json")) {
			t.Fatal("cache was not written")
		}
	}
}

func TestRunSyncCacheInvalidCatalogFails(t *testing.T) {
	openHome, codexHome := syncTestEnv(t)
	syncWriteConfig(t, openHome, syncConfigON())
	writeFileTest(t, filepath.Join(codexHome, "opencodex-catalog.json"), "not-json{")
	var out, errOut bytes.Buffer
	if code := Run([]string{"sync-cache"}, depsFor(RuntimeState{}, &out, &errOut)); code != ExitFailure {
		t.Fatalf("code=%d", code)
	}
	if want := "Cache refresh did not complete (completed). The Codex model cache was not rewritten.\n"; errOut.String() != want {
		t.Fatalf("stderr = %q, want %q", errOut.String(), want)
	}
	if out.String() != "" {
		t.Fatalf("stdout = %q", out.String())
	}
	var outJSON, errOutJSON bytes.Buffer
	if code := Run([]string{"sync-cache", "--json"}, depsFor(RuntimeState{}, &outJSON, &errOutJSON)); code != ExitFailure {
		t.Fatalf("json code=%d", code)
	}
	if want := "{\n  \"schemaVersion\": 1,\n  \"ok\": false,\n  \"wrote\": false,\n  \"skipped\": false,\n  \"outcome\": \"completed\",\n  \"desiredDisabled\": false,\n  \"codexHome\": \"" + codexHome + "\"\n}\n"; outJSON.String() != want {
		t.Fatalf("json stdout = %q", outJSON.String())
	}
}

func TestRunSyncCacheDesktopRestartFlagNonWindows(t *testing.T) {
	if windowsOS() {
		t.Skip("desktop-app restart behavior on Windows is not ported")
	}
	openHome, codexHome := syncTestEnv(t)
	syncWriteConfig(t, openHome, syncConfigON())
	writeFileTest(t, filepath.Join(codexHome, "opencodex-catalog.json"), `{"models":[{"slug":"m1"}]}`)
	var out, errOut bytes.Buffer
	if code := Run([]string{"sync-cache", "--restart-codex", "--restart-desktop-app"}, depsFor(RuntimeState{}, &out, &errOut)); code != ExitOK {
		t.Fatalf("code=%d", code)
	}
	if out.String() != "" {
		t.Fatalf("stdout = %q", out.String())
	}
	if want := syncCacheDesktopWindowsOnly + "\n"; errOut.String() != want {
		t.Fatalf("stderr = %q, want %q", errOut.String(), want)
	}
}

func TestShouldSyncCodexOnStartDecisions(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{name: "absent toggles on", raw: `{}`, want: true},
		{name: "codex true", raw: `{"clientIntegrations":{"codex":true}}`, want: true},
		{name: "codex false", raw: `{"clientIntegrations":{"codex":false}}`, want: false},
		{name: "hub no loopback", raw: `{"runtimeRole":"hub"}`, want: false},
		{name: "hub with loopback", raw: `{"runtimeRole":"hub","unauthenticatedLoopbackListener":{"enabled":true}}`, want: true},
		{name: "hub loopback + codex false", raw: `{"runtimeRole":"hub","unauthenticatedLoopbackListener":{"enabled":true},"clientIntegrations":{"codex":false}}`, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			openHome, _ := syncTestEnv(t)
			syncWriteConfig(t, openHome, tc.raw)
			if got := shouldSyncCodexOnStart(loadRawConfigSafe()); got != tc.want {
				t.Fatalf("shouldSyncCodexOnStart = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestReadCodexCatalogPathForHomeRootToml(t *testing.T) {
	codexHome := t.TempDir()
	if got := readCodexCatalogPathForHome(codexHome); got != filepath.Join(codexHome, "opencodex-catalog.json") {
		t.Fatalf("default path = %q", got)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"),
		[]byte("model_catalog_json = \"/abs/custom.json\"\n\n[model_provider]\nfoo = \"bar\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readCodexCatalogPathForHome(codexHome); got != "/abs/custom.json" {
		t.Fatalf("custom abs path = %q", got)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"),
		[]byte("model_catalog_json = \"rel/custom.json\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readCodexCatalogPathForHome(codexHome); got != filepath.Join(codexHome, "rel/custom.json") {
		t.Fatalf("custom rel path = %q", got)
	}
	// A table line before the key must not hide the root key from readRootTomlString.
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"),
		[]byte("[x]\nmodel_catalog_json = \"ignored\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readCodexCatalogPathForHome(codexHome); got != filepath.Join(codexHome, "opencodex-catalog.json") {
		t.Fatalf("root key must only be read before the first table, got %q", got)
	}
}

func TestIndentedV8JSONMatchesJSONStringifyNumberSemantics(t *testing.T) {
	// TS JSON.parse of exotic literals re-formats them through V8's double:
	// JSON.stringify({v: JSON.parse("1e21"), small: ..., neg: -0.25}, null, 2)
	// renders "1e+21"/"1e-7"/"-0.25"/"0" — never the raw literal spelling.
	obj := jsonwireObjectV8()
	obj.Set("v", jsonNumberFromRaw("1e21"))
	obj.Set("small", jsonNumberFromRaw("1e-7"))
	obj.Set("neg", jsonNumberFromRaw("-0.25"))
	obj.Set("zero", jsonNumberFromRaw("-0"))
	var out strings.Builder
	if err := encodeIndentedJSONV8(&out, obj, 0); err != nil {
		t.Fatal(err)
	}
	if want := "{\n  \"v\": 1e+21,\n  \"small\": 1e-7,\n  \"neg\": -0.25,\n  \"zero\": 0\n}"; out.String() != want {
		t.Fatalf("rendered = %q, want %q", out.String(), want)
	}
}

func windowsOS() bool { return runtime.GOOS == "windows" }

func jsonwireObjectV8() *jsonwire.Value { return jsonwire.ObjectValue() }

func jsonNumberFromRaw(raw string) *jsonwire.Value {
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return jsonwire.NumberFrom(0)
	}
	return jsonwire.NumberFrom(parsed)
}

func TestSyncCacheCatalogArrayForm(t *testing.T) {
	// A catalog whose top-level value is an array writes a cache whose models
	// array mirrors it (TS: `catalog.models ?? catalog`).
	openHome, codexHome := syncTestEnv(t)
	syncWriteConfig(t, openHome, syncConfigON())
	writeFileTest(t, filepath.Join(codexHome, "opencodex-catalog.json"), `[{"slug":"a"},{"slug":"b"}]`)
	var out, errOut bytes.Buffer
	if code := Run([]string{"sync-cache", "--json"}, depsFor(RuntimeState{}, &out, &errOut)); code != ExitOK {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
	raw, err := os.ReadFile(filepath.Join(codexHome, "models_cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "{\n  \"fetched_at\": \"2000-01-01T00:00:00Z\",\n  \"client_version\": \"0.0.0\",\n  \"models\": [\n    {\n      \"slug\": \"a\"\n    },\n    {\n      \"slug\": \"b\"\n    }\n  ]\n}\n"; string(raw) != want {
		t.Fatalf("cache = %q, want %q", string(raw), want)
	}
}
