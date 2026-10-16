/**
 * `ocx capabilities` -- the surface index an agent reads first.
 *
 * The point of this verb is that driving `ocx` programmatically should not require
 * parsing help text. `--json` emits the capability table with the management routes each
 * capability drives; `--route` answers the inverse question.
 */
import {
  CAPABILITIES,
  HEAD_CAPABILITIES,
  capabilitiesForRoute,
  capabilityInvocation,
  type Capability,
} from "./capabilities";
import { takeFlag } from "./runtime-api";

function takeValueFlag(args: string[], flag: string): string | undefined {
  // Order-independent by construction: scan for the flag anywhere in argv rather than
  // reading a fixed position. Positional flag handling is exactly why
  // `ocx restore back --json` ignored its flag.
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  args.splice(idx, value === undefined || value.startsWith("-") ? 1 : 2);
  if (value === undefined || value.startsWith("-")) return "";
  return value;
}

function renderHuman(caps: readonly Capability[], includeHead: boolean): void {
  for (const cap of caps) {
    const marker = cap.mutates ? "!" : " ";
    console.log(`${marker} ${capabilityInvocation(cap)}`);
    console.log(`    ${cap.summary}`);
    if (cap.routes.length > 0) {
      console.log(`    routes: ${cap.routes.map(r => `${r.method} ${r.path}`).join(", ")}`);
    }
    if (cap.flags.length > 0) {
      console.log(`    flags:  ${cap.flags.map(f => f.name).join(" ")}`);
    }
  }
  if (!includeHead) return;
  for (const head of HEAD_CAPABILITIES) {
    console.log(`  ocx ${head.invocations[0]}`);
    console.log(`    ${head.summary}`);
  }
}

/** Render declared capabilities; reject invalid arguments with 64 and report unmatched routes with 4. */
export async function runCapabilities(argv: string[]): Promise<number> {
  const args = [...argv];
  const json = takeFlag(args, "--json");
  const mutatingOnly = takeFlag(args, "--mutating-only");
  const route = takeValueFlag(args, "--route");

  if (args.length > 0 || (route !== undefined && route.trim().length === 0)) {
    console.error("Usage: ocx capabilities [--json] [--mutating-only] [--route <path>]");
    return 64;
  }

  let selected: readonly Capability[] = route === undefined ? CAPABILITIES : capabilitiesForRoute(route);
  if (mutatingOnly) selected = selected.filter(cap => cap.mutates);

  if (route !== undefined && selected.length === 0) {
    // An unmatched route is a real answer, not an error: the route may be exempt or may
    // not exist. Say which, rather than exiting 0 with silence.
    if (json) {
      console.log(JSON.stringify({ schemaVersion: 1, route, capabilities: [] }, null, 2));
    } else {
      console.error(`No CLI capability drives ${route}.`);
    }
    return 4;
  }

  if (json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      ...(route === undefined ? {} : { route }),
      capabilities: selected.map(cap => ({
        command: cap.command,
        invocation: capabilityInvocation(cap),
        summary: cap.summary,
        routes: cap.routes,
        flags: cap.flags,
        mutates: cap.mutates,
        json: cap.json,
        ...(cap.usage !== undefined ? { usage: cap.usage } : {}),
        ...(cap.details ? { details: cap.details } : {}),
      })),
      ...(route === undefined && !mutatingOnly ? { headCapabilities: HEAD_CAPABILITIES } : {}),
    }, null, 2));
    return 0;
  }

  renderHuman(selected, route === undefined && !mutatingOnly);
  return 0;
}
