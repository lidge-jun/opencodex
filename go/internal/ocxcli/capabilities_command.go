package ocxcli

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// ocx capabilities — the declared CLI capability index and its inverse route
// lookup. This file ports src/cli/capabilities-command.ts (plus the leaf data
// table src/cli/capabilities.ts, kept in capabilities_data.go) so the ownership
// flip keeps the documented surface identical: human rows, the --json envelope,
// --mutating-only filtering, and --route <path> inverse lookup share one V8-exact
// JSON renderer with the rest of the Go CLI.
//
// Like the TypeScript owner, argv that names no known flag is ignored rather than
// rejected: `ocx capabilities` is the surface index an agent reads first, and the
// parser only ever recognizes --json, --mutating-only, and --route.

const capabilitiesUsage = "Usage: ocx capabilities --route <path>"

// capabilitiesInvocation renders `ocx <command path>` like capabilityInvocation.
func capabilitiesInvocation(cap capability) string {
	return "ocx " + strings.Join(cap.command, " ")
}

// capabilitiesForRoute returns the capabilities that drive a route path, in
// declaration order (capabilitiesForRoute in capabilities.ts).
func capabilitiesForRoute(path string) []capability {
	var selected []capability
	for _, cap := range capabilitiesTable {
		for _, route := range cap.routes {
			if route.path == path {
				selected = append(selected, cap)
				break
			}
		}
	}
	return selected
}

// takeCapabilitiesValueFlag mirrors takeValueFlag: remove `--route` from args
// anywhere in argv and report its value ("" for a missing or flag-shaped one).
func takeCapabilitiesValueFlag(args []string, flag string) (rest []string, value string, present bool) {
	for index, arg := range args {
		if arg != flag {
			continue
		}
		present = true
		if index+1 < len(args) && !strings.HasPrefix(args[index+1], "-") {
			value = args[index+1]
			rest = append(append([]string(nil), args[:index]...), args[index+2:]...)
			return rest, value, true
		}
		rest = append(append([]string(nil), args[:index]...), args[index+1:]...)
		return rest, "", true
	}
	return args, "", false
}

// capabilityEnvelope builds the --json envelope as an ordered jsonwire tree so
// the pretty printer emits exactly what JSON.stringify(value, null, 2) does.
func capabilityEnvelope(route string, routeGiven bool, selected []capability, mutatingOnly bool) *jsonwire.Value {
	envelope := jsonwire.ObjectValue()
	envelope.Set("schemaVersion", jsonwire.NumberFrom(1))
	if routeGiven {
		envelope.Set("route", jsonwire.StringValue(route))
	}
	caps := jsonwire.EmptyArray()
	for _, cap := range selected {
		entry := jsonwire.ObjectValue()
		command := jsonwire.EmptyArray()
		for _, part := range cap.command {
			command.AppendArray(jsonwire.StringValue(part))
		}
		entry.Set("command", command)
		entry.Set("invocation", jsonwire.StringValue(capabilitiesInvocation(cap)))
		entry.Set("summary", jsonwire.StringValue(cap.summary))
		routes := jsonwire.EmptyArray()
		for _, routeEntry := range cap.routes {
			object := jsonwire.ObjectValue()
			object.Set("method", jsonwire.StringValue(routeEntry.method))
			object.Set("path", jsonwire.StringValue(routeEntry.path))
			routes.AppendArray(object)
		}
		entry.Set("routes", routes)
		flags := jsonwire.EmptyArray()
		for _, flag := range cap.flags {
			object := jsonwire.ObjectValue()
			object.Set("name", jsonwire.StringValue(flag.name))
			if flag.value != "" {
				object.Set("value", jsonwire.StringValue(flag.value))
			}
			if flag.required {
				object.Set("required", jsonwire.BoolValue(true))
			}
			object.Set("summary", jsonwire.StringValue(flag.summary))
			flags.AppendArray(object)
		}
		entry.Set("flags", flags)
		entry.Set("mutates", jsonwire.BoolValue(cap.mutates))
		entry.Set("json", jsonwire.StringValue(cap.json))
		if len(cap.details) > 0 {
			details := jsonwire.EmptyArray()
			for _, detail := range cap.details {
				details.AppendArray(jsonwire.StringValue(detail))
			}
			entry.Set("details", details)
		}
		caps.AppendArray(entry)
	}
	envelope.Set("capabilities", caps)
	if !routeGiven && !mutatingOnly {
		head := jsonwire.EmptyArray()
		for _, entry := range headCapabilitiesTable {
			object := jsonwire.ObjectValue()
			invocations := jsonwire.EmptyArray()
			for _, invocation := range entry.invocations {
				invocations.AppendArray(jsonwire.StringValue(invocation))
			}
			object.Set("invocations", invocations)
			object.Set("summary", jsonwire.StringValue(entry.summary))
			object.Set("bannerLine", jsonwire.StringValue(entry.bannerLine))
			head.AppendArray(object)
		}
		envelope.Set("headCapabilities", head)
	}
	return envelope
}

// renderCapabilitiesHuman mirrors renderHuman in capabilities-command.ts.
func renderCapabilitiesHuman(deps Deps, selected []capability, includeHead bool) {
	for _, cap := range selected {
		marker := " "
		if cap.mutates {
			marker = "!"
		}
		fmt.Fprintf(deps.Stdout, "%s %s\n", marker, capabilitiesInvocation(cap))
		fmt.Fprintf(deps.Stdout, "    %s\n", cap.summary)
		if len(cap.routes) > 0 {
			parts := make([]string, 0, len(cap.routes))
			for _, route := range cap.routes {
				parts = append(parts, route.method+" "+route.path)
			}
			fmt.Fprintf(deps.Stdout, "    routes: %s\n", strings.Join(parts, ", "))
		}
		if len(cap.flags) > 0 {
			names := make([]string, 0, len(cap.flags))
			for _, flag := range cap.flags {
				names = append(names, flag.name)
			}
			fmt.Fprintf(deps.Stdout, "    flags:  %s\n", strings.Join(names, " "))
		}
	}
	if !includeHead {
		return
	}
	for _, head := range headCapabilitiesTable {
		fmt.Fprintf(deps.Stdout, "  ocx %s\n", head.invocations[0])
		fmt.Fprintf(deps.Stdout, "    %s\n", head.summary)
	}
}

// runCapabilities implements `ocx capabilities`.
func runCapabilities(args []string, deps Deps) int {
	jsonOutput := false
	mutatingOnly := false
	rest := append([]string(nil), args...)
	for index := 0; index < len(rest); index++ {
		switch rest[index] {
		case "--json":
			jsonOutput = true
		case "--mutating-only":
			mutatingOnly = true
		}
	}
	var route string
	routeGiven := false
	rest, route, routeGiven = takeCapabilitiesValueFlag(rest, "--route")
	_ = rest
	if routeGiven && route == "" {
		fmt.Fprintln(deps.Stderr, capabilitiesUsage)
		return 64
	}

	var selected []capability
	if routeGiven {
		selected = capabilitiesForRoute(route)
	} else {
		selected = append([]capability(nil), capabilitiesTable...)
	}
	if mutatingOnly {
		filtered := selected[:0:0]
		for _, cap := range selected {
			if cap.mutates {
				filtered = append(filtered, cap)
			}
		}
		selected = filtered
	}

	if routeGiven && len(selected) == 0 {
		if jsonOutput {
			envelope := capabilityEnvelope(route, true, nil, mutatingOnly)
			var out strings.Builder
			if err := encodeIndentedJSON(&out, envelope, 0); err != nil {
				fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
				return 1
			}
			fmt.Fprintln(deps.Stdout, out.String())
		} else {
			fmt.Fprintf(deps.Stderr, "No CLI capability drives %s.\n", route)
		}
		return 4
	}

	if jsonOutput {
		envelope := capabilityEnvelope(route, routeGiven, selected, mutatingOnly)
		var out strings.Builder
		if err := encodeIndentedJSON(&out, envelope, 0); err != nil {
			fmt.Fprintln(deps.Stderr, "Error: "+err.Error())
			return 1
		}
		fmt.Fprintln(deps.Stdout, out.String())
		return 0
	}

	renderCapabilitiesHuman(deps, selected, !routeGiven && !mutatingOnly)
	return 0
}
