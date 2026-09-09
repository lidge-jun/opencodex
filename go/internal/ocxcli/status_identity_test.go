package ocxcli

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestStaticReleaseIdentityIsCWDIndependent(t *testing.T) {
	original, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	repo := typeScriptOracleRepo(t)
	clean := t.TempDir()
	collect := func(dir string) StatusDomains {
		t.Helper()
		if err := os.Chdir(dir); err != nil {
			t.Fatal(err)
		}
		return CollectStatusDomains(StatusDomainDeps{CLIVersion: "2.47.0"})
	}
	t.Cleanup(func() { _ = os.Chdir(original) })
	fromRepo := collect(repo)
	fromClean := collect(clean)
	for _, status := range []StatusDomains{fromRepo, fromClean} {
		if status.Runtime.Source != "go-static" {
			t.Fatalf("runtime source = %q, want go-static", status.Runtime.Source)
		}
		if status.Paths.Runtime == "" || status.Paths.Runtime == "unknown" {
			t.Fatalf("runtime path = %q, want resolved test executable", status.Paths.Runtime)
		}
		if status.VersionSkew.CLIVersion != "2.47.0" {
			t.Fatalf("cli version = %q", status.VersionSkew.CLIVersion)
		}
	}
	if fromRepo.Paths.Runtime != fromClean.Paths.Runtime || fromRepo.Runtime != fromClean.Runtime || fromRepo.VersionSkew != fromClean.VersionSkew {
		t.Fatalf("artifact identity changed by cwd: repo=%#v clean=%#v", fromRepo, fromClean)
	}
}

func TestStaticReleaseIdentityRejectsCWDAndBunMarkers(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "node_modules", "bun", "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "bun", "bin", "bun.exe"), []byte("not bun"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"version":"poisoned"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	t.Setenv("OCX_BUN_RUNTIME_SOURCE", "bundled")
	t.Setenv("OCX_BUN_RUNTIME_PATH", filepath.Join(dir, "node_modules", "bun", "bin", "bun.exe"))
	status := CollectStatusDomains(StatusDomainDeps{CLIVersion: "2.47.0"})
	if status.Runtime.Source != "go-static" || status.Paths.Runtime == filepath.Join(dir, "node_modules", "bun", "bin", "bun.exe") {
		t.Fatalf("artifact identity accepted Bun/cwd marker: %#v", status)
	}
	if status.VersionSkew.CLIVersion != "2.47.0" {
		t.Fatalf("cli version = %q, want injected release version", status.VersionSkew.CLIVersion)
	}
}

func TestStaticReleaseIdentityUsesUnknownForUnresolvedExecutable(t *testing.T) {
	identity := readStatusArtifactRuntime(func() (string, error) { return "", errors.New("unavailable") })
	if identity != (StatusArtifactRuntime{Path: "unknown", Source: "go-static"}) {
		t.Fatalf("identity = %#v", identity)
	}
	status := CollectStatusDomains(StatusDomainDeps{
		CLIVersion:          "2.47.0",
		ReadArtifactRuntime: func() StatusArtifactRuntime { return identity },
	})
	if status.Paths.Runtime != "unknown" || status.Runtime.Source != "go-static" {
		t.Fatalf("status identity = %#v", status)
	}
}

func TestStaticReleaseIdentityDevVersionIsIncomparable(t *testing.T) {
	for _, versions := range [][2]string{{"dev", "2.47.0"}, {"2.47.0", "dev"}, {"dev", "dev"}} {
		status := ComputeStatusVersionSkew(versions[0], versions[1])
		if status.Skewed || status.Warning != nil {
			t.Fatalf("version skew(%q, %q) = %#v", versions[0], versions[1], status)
		}
	}
}
