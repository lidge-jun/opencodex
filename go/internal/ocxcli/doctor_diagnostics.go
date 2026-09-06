package ocxcli

import "strconv"

// DoctorProxyDownInput is the proxy/listen evidence consumed by doctor when it
// decides whether to print a restart hint. The rest of doctor remains
// TypeScript-owned until its complete report has byte parity.
type DoctorProxyDownInput struct {
	ProxyRunning      bool
	Port              int
	ServiceViable     bool
	ServiceInstalled  bool
	ServiceConflict   bool
	StaleProcessState bool
}

// DoctorProxyDownRestartHint is a direct port of proxyDownRestartHint in
// src/cli/doctor.ts. An empty string represents TypeScript's null.
func DoctorProxyDownRestartHint(input DoctorProxyDownInput) string {
	if input.ProxyRunning {
		return ""
	}
	installedButBroken := input.ServiceInstalled && !input.ServiceConflict
	restart := "Restart it with 'ocx start', or install the persistent service: 'ocx service install'."
	if input.ServiceViable {
		restart = "Restart it with 'ocx service start' (service installed) or 'ocx start'."
	} else if installedButBroken {
		restart = "Restart it with 'ocx start', or refresh the installed service: 'ocx service repair'."
	}
	unclean := ""
	if input.StaleProcessState {
		unclean = "Stale process records remain, so the previous run may have exited unexpectedly. "
	}
	return "The ocx proxy is not running. " + unclean + "Codex/Claude clients pinned to 127.0.0.1:" + strconv.Itoa(input.Port) + " fail with errors like \"error sending request for url (http://127.0.0.1:" + strconv.Itoa(input.Port) + "/v1/responses)\". " + restart
}
