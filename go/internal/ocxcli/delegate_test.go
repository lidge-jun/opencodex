package ocxcli

import (
	"os"
	"strings"
	"testing"
)

func TestTypeScriptLifecycleOwnerMissingExplainsStandaloneRepair(t *testing.T) {
	t.Setenv("OCX_TYPESCRIPT_CLI", "")
	t.Setenv("OCX_BUN", "")
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	_, err = typeScriptCLIPath()
	if err == nil {
		t.Fatal("missing lifecycle owner unexpectedly resolved")
	}
	message := err.Error()
	for _, want := range []string{"standalone ocx binary", "OCX_TYPESCRIPT_CLI", "OCX_BUN", "install or update"} {
		if !strings.Contains(message, want) {
			t.Fatalf("error %q does not explain %q", message, want)
		}
	}
}

func TestConfiguredTypeScriptLifecycleOwnerErrorNamesRepairPath(t *testing.T) {
	t.Setenv("OCX_TYPESCRIPT_CLI", "/definitely/missing/ocx-cli.ts")
	_, err := typeScriptCLIPath()
	if err == nil || !strings.Contains(err.Error(), "OCX_TYPESCRIPT_CLI") || !strings.Contains(err.Error(), "install or update") {
		t.Fatalf("configured owner error = %v", err)
	}
}
