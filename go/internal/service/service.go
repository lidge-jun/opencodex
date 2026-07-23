package service

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const (
	LaunchdLabel = "com.opencodex.proxy"
	ServiceName  = "opencodex-proxy"
)

type Config struct {
	Executable  string
	Arguments   []string
	Environment map[string]string
	LogPath     string
	HomeDir     string
	StateDir    string
}

type Status struct {
	Installed bool
	Running   bool
	Detail    string
}

type Manager interface {
	Install() error
	Start() error
	Stop() error
	Uninstall() error
	Status() (Status, error)
	ArtifactPath() string
}

func NewManager(cfg Config) (Manager, error) {
	if strings.TrimSpace(cfg.Executable) == "" {
		return nil, fmt.Errorf("service executable must not be blank")
	}
	if cfg.HomeDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		cfg.HomeDir = home
	}
	switch runtime.GOOS {
	case "darwin":
		return &launchdManager{config: cfg}, nil
	case "linux":
		return &systemdManager{config: cfg}, nil
	case "windows":
		return &taskManager{config: cfg}, nil
	default:
		return nil, fmt.Errorf("services are unsupported on %s", runtime.GOOS)
	}
}

func GenerateLaunchd(cfg Config) (string, error) {
	if cfg.Executable == "" {
		return "", fmt.Errorf("service executable must not be blank")
	}
	type keyValue struct {
		Key   string `xml:"key"`
		Value string `xml:"string"`
	}
	_ = keyValue{}
	args := append([]string{cfg.Executable}, cfg.Arguments...)
	var builder strings.Builder
	builder.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	builder.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	builder.WriteString("<plist version=\"1.0\">\n<dict>\n")
	writePlistPair(&builder, "Label", LaunchdLabel)
	builder.WriteString("  <key>ProgramArguments</key>\n  <array>\n")
	for _, arg := range args {
		builder.WriteString("    <string>" + xmlEscape(arg) + "</string>\n")
	}
	builder.WriteString("  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n")
	builder.WriteString("  <key>EnvironmentVariables</key>\n  <dict>\n")
	for _, key := range sortedKeys(cfg.Environment) {
		writePlistPair(&builder, key, cfg.Environment[key])
	}
	builder.WriteString("  </dict>\n")
	if cfg.LogPath != "" {
		writePlistPair(&builder, "StandardOutPath", cfg.LogPath)
		writePlistPair(&builder, "StandardErrorPath", cfg.LogPath)
	}
	builder.WriteString("</dict>\n</plist>\n")
	return builder.String(), nil
}

func writePlistPair(builder *strings.Builder, key, value string) {
	builder.WriteString("  <key>" + xmlEscape(key) + "</key><string>" + xmlEscape(value) + "</string>\n")
}

func GenerateSystemd(cfg Config) (string, error) {
	if cfg.Executable == "" {
		return "", fmt.Errorf("service executable must not be blank")
	}
	arguments := []string{systemdQuote(cfg.Executable)}
	for _, arg := range cfg.Arguments {
		arguments = append(arguments, systemdQuote(arg))
	}
	var builder strings.Builder
	builder.WriteString("[Unit]\nDescription=OpenCodex Proxy Server\nAfter=network-online.target\nWants=network-online.target\n\n")
	builder.WriteString("[Service]\nType=simple\nExecStart=" + strings.Join(arguments, " ") + "\nRestart=on-failure\nRestartSec=5\n")
	for _, key := range sortedKeys(cfg.Environment) {
		builder.WriteString("Environment=" + systemdQuote(key+"="+cfg.Environment[key]) + "\n")
	}
	if cfg.LogPath != "" {
		logPath := strings.ReplaceAll(cfg.LogPath, "%", "%%")
		builder.WriteString("StandardOutput=append:" + logPath + "\nStandardError=append:" + logPath + "\n")
	}
	builder.WriteString("\n[Install]\nWantedBy=default.target\n")
	return builder.String(), nil
}

func GenerateTaskXML(cfg Config) (string, error) {
	if cfg.Executable == "" {
		return "", fmt.Errorf("service executable must not be blank")
	}
	launcher := taskLauncherPath(cfg)
	wscript := strings.TrimRight(os.Getenv("SystemRoot"), `\/`)
	if wscript == "" {
		wscript = `C:\Windows`
	}
	wscript += `\System32\wscript.exe`
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>OpenCodex proxy service</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
	<Actions Context="Author"><Exec><Command>` + xmlEscape(wscript) + `</Command><Arguments>` + xmlEscape(`/b /nologo `+windowsQuoteAlways(launcher)) + `</Arguments></Exec></Actions>
</Task>
`, nil
}

func GenerateTaskLauncher(cfg Config) (string, error) {
	if cfg.Executable == "" {
		return "", fmt.Errorf("service executable must not be blank")
	}
	parts := []string{windowsQuoteAlways(cfg.Executable)}
	for _, argument := range cfg.Arguments {
		parts = append(parts, windowsQuote(argument))
	}
	commandLine := strings.ReplaceAll(strings.Join(parts, " "), `"`, `""`)
	return "' Generated by ocx service install; do not edit.\r\n" +
		"Set shell = CreateObject(\"WScript.Shell\")\r\n" +
		"WScript.Quit shell.Run(\"" + commandLine + "\", 0, True)\r\n", nil
}

func taskLauncherPath(cfg Config) string {
	dir := cfg.StateDir
	if dir == "" {
		dir = filepath.Join(cfg.HomeDir, ".opencodex")
	}
	return filepath.Join(dir, ServiceName+"-launcher.vbs")
}

func xmlEscape(value string) string {
	var buffer bytes.Buffer
	_ = xml.EscapeText(&buffer, []byte(value))
	return buffer.String()
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func systemdQuote(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, "\n", `\n`)
	return `"` + replacer.Replace(value) + `"`
}

func windowsQuote(value string) string {
	if value != "" && !strings.ContainsAny(value, " \t\n\v\"") {
		return value
	}
	return windowsQuoteAlways(value)
}

func windowsQuoteAlways(value string) string {
	var builder strings.Builder
	builder.WriteByte('"')
	backslashes := 0
	for _, character := range value {
		if character == '\\' {
			backslashes++
			continue
		}
		if character == '"' {
			builder.WriteString(strings.Repeat("\\", backslashes*2+1))
			builder.WriteRune(character)
			backslashes = 0
			continue
		}
		builder.WriteString(strings.Repeat("\\", backslashes))
		backslashes = 0
		builder.WriteRune(character)
	}
	builder.WriteString(strings.Repeat("\\", backslashes*2))
	builder.WriteByte('"')
	return builder.String()
}

type launchdManager struct{ config Config }
type systemdManager struct{ config Config }
type taskManager struct{ config Config }

func (m *launchdManager) ArtifactPath() string {
	return filepath.Join(m.config.HomeDir, "Library", "LaunchAgents", LaunchdLabel+".plist")
}
func (m *systemdManager) ArtifactPath() string {
	return filepath.Join(m.config.HomeDir, ".config", "systemd", "user", ServiceName+".service")
}
func (m *taskManager) ArtifactPath() string {
	dir := m.config.StateDir
	if dir == "" {
		dir = filepath.Join(m.config.HomeDir, ".opencodex")
	}
	return filepath.Join(dir, ServiceName+".xml")
}

func run(name string, args ...string) (string, error) {
	output, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}
