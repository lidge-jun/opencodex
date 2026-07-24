package cursor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const mcpProtocolVersion = "2025-06-18"

type MCPTool struct {
	Name, Description string
	InputSchema       map[string]any
}
type MCPToolHandle struct {
	ServerName, ToolName, AdvertisedName, Description string
	InputSchema                                       map[string]any
}
type MCPContent struct{ Type, Text, Data, MIMEType string }
type MCPCallResult struct {
	IsError bool
	Content []MCPContent
}
type MCPResource struct{ URI, Name, Description, MIMEType, Server string }
type MCPResourceContent struct {
	URI, MIMEType, Text string
	Blob                []byte
}

type MCPClient interface {
	Initialize(context.Context) error
	ListTools(context.Context) ([]MCPTool, error)
	CallTool(context.Context, string, map[string]any) (MCPCallResult, error)
	ListResources(context.Context) ([]MCPResource, error)
	ReadResource(context.Context, string) (MCPResourceContent, error)
	Close() error
}

type MCPManagerOptions struct {
	ConnectTimeout, CallTimeout time.Duration
	ClientFactory               func(ResolvedMCPServer) (MCPClient, error)
	Log                         func(string)
}
type connectedMCP struct {
	config ResolvedMCPServer
	client MCPClient
}
type MCPManager struct {
	resolved []ResolvedMCPServer
	options  MCPManagerOptions
	once     sync.Once
	ready    chan struct{}
	mu       sync.RWMutex
	servers  map[string]connectedMCP
	tools    map[string]MCPToolHandle
}

func NewMCPManager(resolved []ResolvedMCPServer, options MCPManagerOptions) *MCPManager {
	if options.ConnectTimeout <= 0 {
		options.ConnectTimeout = 15 * time.Second
	}
	if options.CallTimeout <= 0 {
		options.CallTimeout = 120 * time.Second
	}
	return &MCPManager{resolved: append([]ResolvedMCPServer(nil), resolved...), options: options, ready: make(chan struct{}), servers: make(map[string]connectedMCP), tools: make(map[string]MCPToolHandle)}
}

func (m *MCPManager) EnsureConnected(ctx context.Context) {
	m.once.Do(func() { go m.connectAll(ctx) })
	<-m.ready
}
func (m *MCPManager) connectAll(ctx context.Context) {
	defer close(m.ready)
	var wg sync.WaitGroup
	for _, server := range m.resolved {
		server := server
		wg.Add(1)
		go func() { defer wg.Done(); m.connectOne(ctx, server) }()
	}
	wg.Wait()
}
func (m *MCPManager) connectOne(parent context.Context, server ResolvedMCPServer) {
	ctx, cancel := context.WithTimeout(parent, m.options.ConnectTimeout)
	defer cancel()
	client, err := m.newClient(server)
	if err == nil {
		err = client.Initialize(ctx)
	}
	if err != nil {
		if client != nil {
			_ = client.Close()
		}
		m.log("server %q failed to connect: %v", server.ServerName, err)
		return
	}
	m.mu.Lock()
	m.servers[server.ServerName] = connectedMCP{server, client}
	m.mu.Unlock()
	tools, err := client.ListTools(ctx)
	if err != nil {
		m.log("server %q tool discovery failed: %v", server.ServerName, err)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, tool := range tools {
		advertised := server.ToolPrefix + tool.Name
		if _, exists := m.tools[advertised]; exists {
			m.log("duplicate advertised tool %q ignored from %q", advertised, server.ServerName)
			continue
		}
		m.tools[advertised] = MCPToolHandle{ServerName: server.ServerName, ToolName: tool.Name, AdvertisedName: advertised, Description: tool.Description, InputSchema: tool.InputSchema}
	}
}
func (m *MCPManager) newClient(server ResolvedMCPServer) (MCPClient, error) {
	if m.options.ClientFactory != nil {
		return m.options.ClientFactory(server)
	}
	if server.Command != "" {
		return newStdioMCPClient(server)
	}
	return newHTTPMCPClient(server), nil
}
func (m *MCPManager) ToolHandles(ctx context.Context) []MCPToolHandle {
	m.EnsureConnected(ctx)
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]MCPToolHandle, 0, len(m.tools))
	for _, tool := range m.tools {
		out = append(out, tool)
	}
	sortToolHandles(out)
	return out
}
func (m *MCPManager) ToolNames(ctx context.Context) []string {
	handles := m.ToolHandles(ctx)
	out := make([]string, len(handles))
	for i := range handles {
		out[i] = handles[i].AdvertisedName
	}
	return out
}
func (m *MCPManager) CallTool(ctx context.Context, name string, args map[string]any) (MCPCallResult, error) {
	m.EnsureConnected(ctx)
	m.mu.RLock()
	handle, ok := m.tools[name]
	conn := m.servers[handle.ServerName]
	m.mu.RUnlock()
	if !ok {
		return MCPCallResult{}, fmt.Errorf("MCP tool not found: %s", name)
	}
	callCtx, cancel := context.WithTimeout(ctx, m.options.CallTimeout)
	defer cancel()
	return conn.client.CallTool(callCtx, handle.ToolName, args)
}
func (m *MCPManager) ListResources(ctx context.Context, server string) ([]MCPResource, error) {
	m.EnsureConnected(ctx)
	m.mu.RLock()
	targets := make([]connectedMCP, 0, len(m.servers))
	for name, conn := range m.servers {
		if server == "" || name == server {
			targets = append(targets, conn)
		}
	}
	m.mu.RUnlock()
	if server != "" && len(targets) == 0 {
		return nil, fmt.Errorf("MCP server not connected: %s", server)
	}
	var out []MCPResource
	var errs []error
	for _, conn := range targets {
		callCtx, cancel := context.WithTimeout(ctx, m.options.CallTimeout)
		resources, err := conn.client.ListResources(callCtx)
		cancel()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", conn.config.ServerName, err))
			continue
		}
		for i := range resources {
			resources[i].Server = conn.config.ServerName
		}
		out = append(out, resources...)
	}
	if len(out) > 0 || len(errs) == 0 {
		for _, err := range errs {
			m.log("resource discovery isolated failure: %v", err)
		}
		return out, nil
	}
	return nil, errors.Join(errs...)
}
func (m *MCPManager) ReadResource(ctx context.Context, server, uri string) (MCPResourceContent, error) {
	m.EnsureConnected(ctx)
	m.mu.RLock()
	conn, ok := m.servers[server]
	m.mu.RUnlock()
	if !ok {
		return MCPResourceContent{}, fmt.Errorf("MCP server not connected: %s", server)
	}
	callCtx, cancel := context.WithTimeout(ctx, m.options.CallTimeout)
	defer cancel()
	return conn.client.ReadResource(callCtx, uri)
}
func (m *MCPManager) Close() error {
	m.mu.Lock()
	servers := m.servers
	m.servers = make(map[string]connectedMCP)
	m.tools = make(map[string]MCPToolHandle)
	m.mu.Unlock()
	var errs []error
	for name, conn := range servers {
		if err := conn.client.Close(); err != nil {
			errs = append(errs, fmt.Errorf("close %s: %w", name, err))
		}
	}
	return errors.Join(errs...)
}
func (m *MCPManager) log(format string, args ...any) {
	if m.options.Log != nil {
		m.options.Log("[cursor-mcp] " + fmt.Sprintf(format, args...))
	}
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}
type rpcCaller interface {
	call(context.Context, string, any, any) error
	notify(context.Context, string, any) error
}

func initializeRPC(ctx context.Context, rpc rpcCaller) error {
	var result json.RawMessage
	if err := rpc.call(ctx, "initialize", map[string]any{"protocolVersion": mcpProtocolVersion, "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "opencodex", "version": "1.0.0"}}, &result); err != nil {
		return err
	}
	return rpc.notify(ctx, "notifications/initialized", nil)
}
func listToolsRPC(ctx context.Context, rpc rpcCaller) ([]MCPTool, error) {
	var result struct {
		Tools []MCPTool `json:"tools"`
	}
	if err := rpc.call(ctx, "tools/list", map[string]any{}, &result); err != nil {
		return nil, err
	}
	return result.Tools, nil
}
func callToolRPC(ctx context.Context, rpc rpcCaller, name string, args map[string]any) (MCPCallResult, error) {
	var result MCPCallResult
	err := rpc.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, &result)
	return result, err
}
func listResourcesRPC(ctx context.Context, rpc rpcCaller) ([]MCPResource, error) {
	var result struct {
		Resources []MCPResource `json:"resources"`
	}
	if err := rpc.call(ctx, "resources/list", map[string]any{}, &result); err != nil {
		return nil, err
	}
	return result.Resources, nil
}
func readResourceRPC(ctx context.Context, rpc rpcCaller, uri string) (MCPResourceContent, error) {
	var result struct {
		Contents []struct{ URI, MIMEType, Text, Blob string } `json:"contents"`
	}
	if err := rpc.call(ctx, "resources/read", map[string]string{"uri": uri}, &result); err != nil {
		return MCPResourceContent{}, err
	}
	if len(result.Contents) == 0 {
		return MCPResourceContent{URI: uri}, nil
	}
	first := result.Contents[0]
	blob, err := base64.StdEncoding.DecodeString(first.Blob)
	if first.Blob != "" && err != nil {
		return MCPResourceContent{}, err
	}
	return MCPResourceContent{URI: first.URI, MIMEType: first.MIMEType, Text: first.Text, Blob: blob}, nil
}

type stdioMCPClient struct {
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	responses   chan rpcResponse
	readErr     chan error
	processDone chan error
	nextID      atomic.Int64
	mu          sync.Mutex
}

func newStdioMCPClient(server ResolvedMCPServer) (*stdioMCPClient, error) {
	cmd := exec.Command(server.Command, server.Args...)
	cmd.Dir = server.WorkingDirectory
	cmd.Env = os.Environ()
	for k, v := range server.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 8_000_000)
	client := &stdioMCPClient{cmd: cmd, stdin: stdin, responses: make(chan rpcResponse, 16), readErr: make(chan error, 1), processDone: make(chan error, 1)}
	go client.readLoop(scanner)
	go func() { client.processDone <- cmd.Wait() }()
	return client, nil
}
func (c *stdioMCPClient) Initialize(ctx context.Context) error { return initializeRPC(ctx, c) }
func (c *stdioMCPClient) ListTools(ctx context.Context) ([]MCPTool, error) {
	return listToolsRPC(ctx, c)
}
func (c *stdioMCPClient) CallTool(ctx context.Context, n string, a map[string]any) (MCPCallResult, error) {
	return callToolRPC(ctx, c, n, a)
}
func (c *stdioMCPClient) ListResources(ctx context.Context) ([]MCPResource, error) {
	return listResourcesRPC(ctx, c)
}
func (c *stdioMCPClient) ReadResource(ctx context.Context, u string) (MCPResourceContent, error) {
	return readResourceRPC(ctx, c, u)
}
func (c *stdioMCPClient) Close() error {
	_ = c.stdin.Close()
	select {
	case err := <-c.processDone:
		return err
	case <-time.After(2 * time.Second):
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
		<-c.processDone
		return nil
	}
}
func (c *stdioMCPClient) notify(_ context.Context, m string, p any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return json.NewEncoder(c.stdin).Encode(rpcRequest{JSONRPC: "2.0", Method: m, Params: p})
}
func (c *stdioMCPClient) call(ctx context.Context, m string, p, out any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.nextID.Add(1)
	if err := json.NewEncoder(c.stdin).Encode(rpcRequest{JSONRPC: "2.0", ID: id, Method: m, Params: p}); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-c.readErr:
			if err == nil {
				return io.ErrUnexpectedEOF
			}
			return err
		case response := <-c.responses:
			if response.ID != id {
				continue
			}
			if response.Error != nil {
				return fmt.Errorf("MCP RPC %d: %s", response.Error.Code, response.Error.Message)
			}
			return json.Unmarshal(response.Result, out)
		}
	}
}

func (c *stdioMCPClient) readLoop(scanner *bufio.Scanner) {
	for scanner.Scan() {
		var response rpcResponse
		if json.Unmarshal(scanner.Bytes(), &response) == nil && response.ID != 0 {
			c.responses <- response
		}
	}
	c.readErr <- scanner.Err()
}

type httpMCPClient struct {
	url       string
	headers   map[string]string
	client    *http.Client
	nextID    atomic.Int64
	mu        sync.Mutex
	sessionID string
}

func newHTTPMCPClient(server ResolvedMCPServer) *httpMCPClient {
	return &httpMCPClient{url: server.URL, headers: server.Headers, client: &http.Client{Timeout: 2 * time.Minute}}
}
func (c *httpMCPClient) Initialize(ctx context.Context) error { return initializeRPC(ctx, c) }
func (c *httpMCPClient) ListTools(ctx context.Context) ([]MCPTool, error) {
	return listToolsRPC(ctx, c)
}
func (c *httpMCPClient) CallTool(ctx context.Context, n string, a map[string]any) (MCPCallResult, error) {
	return callToolRPC(ctx, c, n, a)
}
func (c *httpMCPClient) ListResources(ctx context.Context) ([]MCPResource, error) {
	return listResourcesRPC(ctx, c)
}
func (c *httpMCPClient) ReadResource(ctx context.Context, u string) (MCPResourceContent, error) {
	return readResourceRPC(ctx, c, u)
}
func (c *httpMCPClient) Close() error { return nil }
func (c *httpMCPClient) notify(ctx context.Context, m string, p any) error {
	return c.send(ctx, rpcRequest{JSONRPC: "2.0", Method: m, Params: p}, nil)
}
func (c *httpMCPClient) call(ctx context.Context, m string, p, out any) error {
	id := c.nextID.Add(1)
	var response rpcResponse
	if err := c.send(ctx, rpcRequest{JSONRPC: "2.0", ID: id, Method: m, Params: p}, &response); err != nil {
		return err
	}
	if response.Error != nil {
		return fmt.Errorf("MCP RPC %d: %s", response.Error.Code, response.Error.Message)
	}
	return json.Unmarshal(response.Result, out)
}
func (c *httpMCPClient) send(ctx context.Context, payload rpcRequest, out *rpcResponse) error {
	data, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	c.mu.Lock()
	if c.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", c.sessionID)
	}
	c.mu.Unlock()
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		c.mu.Lock()
		c.sessionID = sid
		c.mu.Unlock()
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("MCP HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if out == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8_000_000))
	if err != nil {
		return err
	}
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		for _, line := range strings.Split(string(body), "\n") {
			if strings.HasPrefix(line, "data:") {
				body = []byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
				break
			}
		}
	}
	return json.Unmarshal(body, out)
}

func sortToolHandles(handles []MCPToolHandle) {
	for i := 1; i < len(handles); i++ {
		for j := i; j > 0 && handles[j].AdvertisedName < handles[j-1].AdvertisedName; j-- {
			handles[j], handles[j-1] = handles[j-1], handles[j]
		}
	}
}
