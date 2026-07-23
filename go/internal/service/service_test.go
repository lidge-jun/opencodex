package service

import (
	"strings"
	"testing"
)

func testConfig() Config {
	return Config{Executable: "/opt/Open Codex/ocx", Arguments: []string{"serve", "--port", "10100"}, Environment: map[string]string{"OCX_SERVICE": "1", "PATH": "/usr/bin:/bin"}, LogPath: "/tmp/open codex.log"}
}

func TestGenerateLaunchd(t *testing.T) {
	artifact, err := GenerateLaunchd(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{LaunchdLabel, "<key>ProgramArguments</key>", "/opt/Open Codex/ocx", "<key>KeepAlive</key><true/>", "OCX_SERVICE"} {
		if !strings.Contains(artifact, expected) {
			t.Errorf("plist missing %q", expected)
		}
	}
}

func TestGenerateSystemd(t *testing.T) {
	artifact, err := GenerateSystemd(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"ExecStart=\"/opt/Open Codex/ocx\" \"serve\"", "Restart=on-failure", "Environment=\"OCX_SERVICE=1\"", "WantedBy=default.target"} {
		if !strings.Contains(artifact, expected) {
			t.Errorf("unit missing %q\n%s", expected, artifact)
		}
	}
}

func TestGenerateTaskXML(t *testing.T) {
	artifact, err := GenerateTaskXML(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"<LogonType>InteractiveToken</LogonType>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<Hidden>true</Hidden>", "<RestartOnFailure>", "wscript.exe", "opencodex-proxy-launcher.vbs"} {
		if !strings.Contains(artifact, expected) {
			t.Errorf("task XML missing %q", expected)
		}
	}
	launcher, err := GenerateTaskLauncher(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(launcher, `shell.Run("""/opt/Open Codex/ocx"" serve --port 10100", 0, True)`) {
		t.Fatalf("unexpected launcher:\n%s", launcher)
	}
}

func TestGeneratorsEscapeArtifactValues(t *testing.T) {
	cfg := testConfig()
	cfg.Executable = `/tmp/ocx&proxy`
	cfg.Arguments = []string{`say "hello"`}
	plist, err := GenerateLaunchd(cfg)
	if err != nil {
		t.Fatal(err)
	}
	task, err := GenerateTaskXML(cfg)
	if err != nil {
		t.Fatal(err)
	}
	launcher, err := GenerateTaskLauncher(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plist, "/tmp/ocx&amp;proxy") || !strings.Contains(task, "wscript.exe") || !strings.Contains(launcher, "/tmp/ocx&proxy") {
		t.Fatal("XML values were not escaped")
	}
}
