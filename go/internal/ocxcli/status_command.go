package ocxcli

// StatusCommandJSON is the ordered top-level JSON projection produced by the
// native status assembler. It matches collectStatus() in src/cli/status.ts.
type StatusCommandJSON struct {
	SchemaVersion   int                     `json:"schemaVersion"`
	Proxy           StatusProxyDomain       `json:"proxy"`
	Dashboard       StatusDashboardDomain   `json:"dashboard"`
	Listen          StatusListenDomain      `json:"listen"`
	Paths           StatusPathsDomain       `json:"paths"`
	Runtime         StatusRuntimeDomain     `json:"runtime"`
	CodexAutostart  bool                    `json:"codexAutostart"`
	Startup         StatusStartupDomain     `json:"startup"`
	DefaultProvider string                  `json:"defaultProvider"`
	Config          StatusConfigDomain      `json:"config"`
	Connection      StatusConnectionDomain  `json:"connection"`
	Service         StatusExternalSummary   `json:"service"`
	CodexShim       StatusExternalSummary   `json:"codexShim"`
	CodexPlugins    StatusPluginsDomain     `json:"codexPlugins"`
	CodexRuntime    StatusCodexRuntime      `json:"codexRuntime"`
	CodexHome       StatusCodexHome         `json:"codexHome"`
	ClaudeDesktop   StatusClaudeDesktop     `json:"claudeDesktop"`
	VersionSkew     StatusVersionSkewDomain `json:"versionSkew"`
}

type StatusCommandDeps struct {
	Domains  StatusDomainDeps
	External func() StatusExternalDomains
}

func CollectStatusCommand(deps StatusCommandDeps) StatusCommandJSON {
	domains := CollectStatusDomains(deps.Domains)
	externalFn := deps.External
	if externalFn == nil {
		externalFn = CollectStatusExternalDomains
	}
	external := externalFn()
	return StatusCommandJSON{
		SchemaVersion: domains.SchemaVersion, Proxy: domains.Proxy, Dashboard: domains.Dashboard, Listen: domains.Listen,
		Paths: domains.Paths, Runtime: domains.Runtime, CodexAutostart: domains.CodexAutostart, Startup: domains.Startup,
		DefaultProvider: domains.DefaultProvider, Config: domains.Config, Connection: domains.Connection, Service: external.Service,
		CodexShim: external.CodexShim, CodexPlugins: external.CodexPlugins, CodexRuntime: external.CodexRuntime,
		CodexHome: external.CodexHome, ClaudeDesktop: external.ClaudeDesktop, VersionSkew: domains.VersionSkew,
	}
}
