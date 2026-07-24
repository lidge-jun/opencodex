package cursor

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type NativeExecMode string

const (
	ExecOff          NativeExecMode = "off"
	ExecCodexSandbox NativeExecMode = "codex-sandbox"
	ExecOn           NativeExecMode = "on"
)

var ErrPolicyDenied = errors.New("cursor native exec denied by policy")

// ProviderPolicy is trusted, server-owned configuration. Only ExecOn enables local exec.
type ProviderPolicy struct {
	Mode                  NativeExecMode
	LegacyUnsafeAllow     bool
	FilesystemRoots       []string
	AllowedNetworkDomains []string
	AllowPrivateNetwork   bool
	MaxReadBytes          int64
	MaxWriteBytes         int64
	MaxFetchBytes         int64
	MaxGrepResults        int
}

// RequestPolicy may reduce provider permissions but can never grant them.
type RequestPolicy struct {
	DenyFilesystem bool
	DenyMutations  bool
	DenyShell      bool
	DenyNetwork    bool
}

type ExecPolicy struct {
	Provider ProviderPolicy
	Request  RequestPolicy
}

func (p ExecPolicy) mode() NativeExecMode {
	if p.Provider.Mode == ExecOff || p.Provider.Mode == ExecCodexSandbox || p.Provider.Mode == ExecOn {
		return p.Provider.Mode
	}
	if p.Provider.LegacyUnsafeAllow {
		return ExecOn
	}
	return ExecOff
}

func (p ExecPolicy) allowLocal(kind string) error {
	if p.mode() != ExecOn {
		return fmt.Errorf("%w: nativeLocalExec must be explicitly set to on", ErrPolicyDenied)
	}
	switch kind {
	case "read", "list", "grep":
		if p.Request.DenyFilesystem {
			return fmt.Errorf("%w: filesystem access disabled for request", ErrPolicyDenied)
		}
	case "write", "delete":
		if p.Request.DenyFilesystem || p.Request.DenyMutations {
			return fmt.Errorf("%w: filesystem mutation disabled for request", ErrPolicyDenied)
		}
	case "shell":
		if p.Request.DenyShell {
			return fmt.Errorf("%w: shell access disabled for request", ErrPolicyDenied)
		}
	case "network":
		if p.Request.DenyNetwork {
			return fmt.Errorf("%w: network access disabled for request", ErrPolicyDenied)
		}
	}
	return nil
}

func (p ExecPolicy) CheckPath(operation, path string) (string, error) {
	if err := p.allowLocal(operation); err != nil {
		return "", err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	resolved, err := resolveExistingPath(abs)
	if err != nil {
		return "", err
	}
	if len(p.Provider.FilesystemRoots) == 0 {
		return abs, nil
	}
	for _, root := range p.Provider.FilesystemRoots {
		rootAbs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rootResolved, err := resolveExistingPath(rootAbs)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(rootResolved, resolved)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return abs, nil
		}
	}
	return "", fmt.Errorf("%w: path %q is outside allowed roots", ErrPolicyDenied, abs)
}

// resolveExistingPath resolves symlinks in the nearest existing ancestor, including write targets.
func resolveExistingPath(path string) (string, error) {
	cur := filepath.Clean(path)
	var suffix []string
	for {
		resolved, err := filepath.EvalSymlinks(cur)
		if err == nil {
			return filepath.Join(append([]string{resolved}, reverse(suffix)...)...), nil
		}
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("resolve symlinks: %w", err)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return path, nil
		}
		suffix = append(suffix, filepath.Base(cur))
		cur = parent
	}
}

func reverse(parts []string) []string {
	out := make([]string, len(parts))
	for i := range parts {
		out[len(parts)-1-i] = parts[i]
	}
	return out
}

func (p ExecPolicy) CheckURL(raw string) (*url.URL, error) {
	if err := p.allowLocal("network"); err != nil {
		return nil, err
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, fmt.Errorf("%w: only absolute http/https URLs are allowed", ErrPolicyDenied)
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if len(p.Provider.AllowedNetworkDomains) > 0 && !domainAllowed(host, p.Provider.AllowedNetworkDomains) {
		return nil, fmt.Errorf("%w: domain %q is not allowed", ErrPolicyDenied, host)
	}
	if !p.Provider.AllowPrivateNetwork {
		ips, err := net.LookupIP(host)
		if err != nil {
			return nil, fmt.Errorf("resolve host: %w", err)
		}
		for _, ip := range ips {
			if privateOrMetadataIP(ip) {
				return nil, fmt.Errorf("%w: private or metadata destination", ErrPolicyDenied)
			}
		}
	}
	return u, nil
}

func domainAllowed(host string, domains []string) bool {
	for _, raw := range domains {
		d := strings.ToLower(strings.Trim(strings.TrimSpace(raw), "."))
		if d != "" && (host == d || strings.HasSuffix(host, "."+d)) {
			return true
		}
	}
	return false
}

func privateOrMetadataIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	return ip.String() == "169.254.169.254" || ip.String() == "100.100.100.200"
}

func maxOr(value, fallback int64) int64 {
	if value > 0 {
		return value
	}
	return fallback
}
