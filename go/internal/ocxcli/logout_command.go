// ocx logout — Go-native port of the TypeScript dispatch handler in
// src/cli/dispatch.ts plus removeCredential in src/oauth/store.ts.
//
// The differential oracle diffs this implementation against the TypeScript CLI
// for the same argv and home: argument validation (exit 2, usage line naming
// the problem), the not-found disposition (exit 4, JSON envelope or stderr
// line), the success path (exit 0, "Logged out of <name>."), and the resulting
// auth.json bytes. Every mutation runs read-normalise-remove-persist exactly
// like mutateStore so the on-disk store matches what TypeScript would leave.
package ocxcli

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const logoutUsagePrefix = "Usage: ocx logout <provider> [--json]"

// isValidOAuthProviderName mirrors isValidProviderName in
// src/config/provider-name.ts: trim-stable, alphanumeric start/end with
// internal ._- allowed, max 64 chars, and none of the reserved object keys.
func isValidOAuthProviderName(name string) bool {
	if name != strings.TrimSpace(name) {
		return false
	}
	switch strings.ToLower(name) {
	case "__proto__", "prototype", "constructor", "policy":
		return false
	}
	if len(name) == 0 || len(name) > 64 {
		return false
	}
	runes := []rune(name)
	valid := func(r rune) bool {
		return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-'
	}
	if !valid(runes[0]) || !valid(runes[len(runes)-1]) {
		return false
	}
	for _, r := range runes {
		if !valid(r) {
			return false
		}
	}
	return true
}

// runLogout parses argv the way the TypeScript dispatch does and returns the
// process code. provider is the only positional; any leading-dash token is an
// option, --json is the only recognised one.
func runLogout(args []string, deps Deps) int {
	logoutArgs := args
	wantsJSON := false
	var unknownFlags []string
	var positionals []string
	for _, arg := range logoutArgs {
		if strings.HasPrefix(arg, "-") {
			if arg != "--json" {
				unknownFlags = append(unknownFlags, arg)
			} else {
				wantsJSON = true
			}
			continue
		}
		positionals = append(positionals, arg)
	}
	name := ""
	if len(positionals) > 0 {
		name = strings.TrimSpace(positionals[0])
	}
	name = strings.ToLower(name)
	malformed := name != "" && !isValidOAuthProviderName(name)

	if len(unknownFlags) > 0 || len(positionals) > 1 || name == "" || malformed {
		problem := ""
		switch {
		case len(unknownFlags) > 0:
			problem = "unknown option " + unknownFlags[0]
		case len(positionals) > 1:
			problem = "too many arguments"
		case malformed:
			problem = "not a valid provider name: " + name
		default:
			problem = "missing provider"
		}
		deps = defaults(deps)
		reportLogoutUsage(deps, problem)
		return 2
	}

	outcome, ioErr := logoutRemoveCredential(deps, name)
	if ioErr != nil {
		deps = defaults(deps)
		fmt.Fprintln(deps.Stderr, "Error: could not update the auth store: "+ioErr.Error())
		return 1
	}
	if outcome == "not-found" {
		if wantsJSON {
			reportLogoutJSON(deps, logoutEnvelope(false, name, "not_found"))
		} else {
			deps = defaults(deps)
			reportLogoutStderr(deps, "No stored credential for '"+name+"'.")
		}
		return 4
	}
	if wantsJSON {
		reportLogoutJSON(deps, logoutEnvelope(true, name, ""))
	} else {
		deps = defaults(deps)
		reportLogoutStdout(deps, "Logged out of "+name+".")
	}
	return 0
}

func reportLogoutUsage(deps Deps, problem string) {
	deps = defaults(deps)
	fmt.Fprintln(deps.Stderr, logoutUsagePrefix+"  ("+problem+")")
}

func reportLogoutStderr(deps Deps, line string) {
	deps = defaults(deps)
	fmt.Fprintln(deps.Stderr, line)
}

func reportLogoutStdout(deps Deps, line string) {
	deps = defaults(deps)
	fmt.Fprintln(deps.Stdout, line)
}

// logoutEnvelope mirrors the --json result objects:
// {schemaVersion:1, ok:false, provider, removed:false, reason:"not_found"} or
// {schemaVersion:1, ok:true, provider, removed:true}.
func logoutEnvelope(ok bool, name string, reason string) *jsonwire.Value {
	out := jsonwire.ObjectValue()
	out.Set("schemaVersion", jsonwire.NumberFrom(1))
	out.Set("ok", jsonwire.BoolValue(ok))
	out.Set("provider", jsonwire.StringValue(name))
	out.Set("removed", jsonwire.BoolValue(ok))
	if reason != "" {
		out.Set("reason", jsonwire.StringValue(reason))
	}
	return out
}

func reportLogoutJSON(deps Deps, value *jsonwire.Value) {
	deps = defaults(deps)
	pretty, err := value.EncodePretty()
	if err != nil {
		fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
		return
	}
	deps.Stdout.Write(pretty)
	fmt.Fprintln(deps.Stdout, "")
}

// logoutRemoveCredential mirrors removeCredential: remove the ACTIVE account
// of the named provider; promote the first remaining account; drop the
// provider when none remain; always persist the normalised store (even for a
// not-found provider, exactly like mutateStore). A second return value carries
// a store IO error (read or write) that the caller reports as exit 1.
func logoutRemoveCredential(deps Deps, provider string) (string, error) {
	store, err := readAuthStore()
	if err != nil {
		return "not-found", err
	}
	set := store.Find(provider)
	if set == nil || set.Kind() != jsonwire.Object {
		return "not-found", writeAuthStore(store)
	}
	accounts := set.Find("accounts")
	if accounts == nil || accounts.Kind() != jsonwire.Array {
		return "not-found", writeAuthStore(store)
	}
	active := ""
	if activeField := set.Find("activeAccountId"); activeField != nil && activeField.Kind() == jsonwire.String {
		active = activeField.String()
	}
	remaining := jsonwire.EmptyArray()
	for _, element := range accounts.Elements() {
		id := ""
		if idField := element.Find("id"); idField != nil && idField.Kind() == jsonwire.String {
			id = idField.String()
		}
		if id != active {
			remaining.AppendArray(element)
		}
	}
	if len(remaining.Elements()) == 0 {
		store.Delete(provider)
	} else {
		firstID := ""
		if idField := remaining.Elements()[0].Find("id"); idField != nil && idField.Kind() == jsonwire.String {
			firstID = idField.String()
		}
		set.Set("activeAccountId", jsonwire.StringValue(firstID))
		set.Set("accounts", remaining)
	}
	return "removed", writeAuthStore(store)
}
