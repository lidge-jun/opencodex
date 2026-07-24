package cursor

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

type MCPServerConfig struct {
	Command          string            `json:"command,omitempty"`
	Args             []string          `json:"args,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	WorkingDirectory string            `json:"cwd,omitempty"`
	URL              string            `json:"url,omitempty"`
	Headers          map[string]string `json:"headers,omitempty"`
	Enabled          *bool             `json:"enabled,omitempty"`
	ToolPrefix       string            `json:"toolPrefix,omitempty"`
}

type CursorProviderConfig struct {
	MCPServers map[string]MCPServerConfig `json:"mcpServers,omitempty"`
}
type ResolvedMCPServer struct {
	ServerName string
	MCPServerConfig
}

func ResolveMCPServers(provider CursorProviderConfig) ([]ResolvedMCPServer, error) {
	names := make([]string, 0, len(provider.MCPServers))
	for name := range provider.MCPServers {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]ResolvedMCPServer, 0, len(names))
	for _, name := range names {
		cfg := provider.MCPServers[name]
		if cfg.Enabled != nil && !*cfg.Enabled {
			continue
		}
		if strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("MCP server name must not be empty")
		}
		if (cfg.Command == "") == (cfg.URL == "") {
			return nil, fmt.Errorf("MCP server %q must configure exactly one of command or url", name)
		}
		if cfg.URL != "" {
			parsed, err := url.Parse(cfg.URL)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
				return nil, fmt.Errorf("MCP server %q has invalid URL", name)
			}
		}
		cfg.Args = append([]string(nil), cfg.Args...)
		cfg.Env = cloneStringMap(cfg.Env)
		cfg.Headers = cloneStringMap(cfg.Headers)
		out = append(out, ResolvedMCPServer{ServerName: name, MCPServerConfig: cfg})
	}
	return out, nil
}

func cloneStringMap(input map[string]string) map[string]string {
	if input == nil {
		return nil
	}
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
