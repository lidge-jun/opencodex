import type { Capability, CapabilityFlag } from "./capability-types";

const device: CapabilityFlag = { name: "--device", value: "string", summary: "Home: alias, id, all or this. Child: this or its own link id only." };
const json: CapabilityFlag = { name: "--json", value: "boolean", summary: "Emit the ocx.route-to/1 status matrix." };
const overwrite: CapabilityFlag = { name: "--overwrite-conflict", value: "boolean", summary: "Explicitly permit replacing conflicting managed blocks." };
const local: CapabilityFlag = { name: "--local", value: "boolean", summary: "Child only: opt out with off, or clear the opt-out with inherit." };

export const ROUTE_TO_CAPABILITIES: readonly Capability[] = [
  {
    command: ["route", "to"],
    usage: "ocx route to <client> <on|off|inherit> [--device <alias|id|this>] [--accounts <all|none|userId,...>] [--model-names <alias|routed>] [--overwrite-conflict] [--local] [--json]",
    summary: "Set Home-default or per-device route intent, or opt out locally on a Child.",
    routes: [{ method: "PUT", path: "/api/route-to" }],
    flags: [device, json, overwrite, local,
      { name: "--accounts", value: "string", summary: "Aside on only: all, none, or comma-separated stable userIds; never u/N slots." },
      { name: "--model-names", value: "string", summary: "Hermes/Command Code on only: alias or routed model names." },
    ],
    mutates: true, json: "payload",
    details: ["Clients: codex, claude, claude-desktop, grok and the supported file integrations. Without --device a Home updates its default and materializes itself; all is only for status/sync.",
      "inherit requires --device unless clearing a Child --local opt-out. Child writes print the exact Home command with the Child link id; --local supports off/inherit only. --overwrite-conflict applies only to on or sync.",
      "On the Home, codex, claude, grok and claude-desktop follow the Home's own native switches: a Home default or --device home write for them writes that switch (Home inherit sets it to the default)."],
  },
  {
    command: ["route", "to", "status"],
    usage: "ocx route to status [--device <alias|id|all|this>] [--json]",
    summary: "Read per-device route intent, its source and actual client apply outcomes.",
    routes: [{ method: "GET", path: "/api/route-to" }],
    flags: [device, json], mutates: false, json: "payload",
    details: ["On a Child this reads local receipts without a Home management relay. Intent and applied state are distinct; null applied means no recorded outcome.",
      "Sources: builtin, default, device, local (Child opt-out) and native (a Home row governed by the Home's own switch). An outcome recorded for an earlier intent reads stale.",
      "Intent unresolved appears only for Aside, while the Home's existing Aside profiles have no stable userIds and nothing decided Aside; warnings[] then names the fix (ocx route to aside on|off --device home)."],
  },
  {
    command: ["route", "to", "sync"],
    usage: "ocx route to sync [--device <alias|id|all|this>] [--overwrite-conflict] [--json]",
    summary: "Reapply route intent on selected devices, or locally on a Child.",
    routes: [{ method: "POST", path: "/api/route-to/sync" }],
    flags: [device, overwrite, json], mutates: true, json: "payload",
    details: ["No conflict retry or implicit overwrite. Child sync calls its local materializer and sends no Home management write.",
      "Home sync never changes the Home's native switches for codex, claude, grok or claude-desktop; it refreshes what each switch says.",
      "On a Home whose Aside ownership is unresolved, sync applies every other client, leaves Aside unchanged, reports it unresolved and prints the warning; that alone does not fail the sync."],
  },
];
