import { getCredentialRuntimeService } from "../credentials";
import type { CredentialRole, CredentialType } from "../credentials/types";
import { isJsonOption } from "./runtime-api";

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function confirmDanger(args: string[]): boolean {
  return hasFlag(args, "--yes") || hasFlag(args, "-y") || hasFlag(args, "--force");
}

export async function runCredentials(args: string[]): Promise<number> {
  const json = args.some(a => typeof a === "string" && isJsonOption(a));
  const cleanArgs = args.filter(a => typeof a === "string" && !isJsonOption(a));
  const sub = cleanArgs[0]?.toLowerCase();
  const service = getCredentialRuntimeService();

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    if (json) {
      printJson({
        commands: [
          "overview", "list", "show", "import", "validate", "activate",
          "quarantine", "revoke", "rotate", "disable", "health", "lease",
          "release", "oauth", "policy", "approve", "audit", "providers",
        ],
      });
      return 0;
    }
    console.log(`Usage: ocx credentials <command> [options]

Provider Access Control Plane (Pao-hubPro × Grok-Register)

Credentials are leased, never listed as plaintext. Health checks in this
phase are fixture/in-process. This command never registers provider accounts,
solves CAPTCHA, or acquires unauthorized sessions.
Set CREDENTIAL_RUNTIME_ENABLED=true before mutating credentials.

Commands:
  overview                         Control-plane counts and vault state
  list [--provider <slug>]         Masked credential inventory
  show <id>                        Masked credential detail
  import --provider <slug> --name <n> --secret <value>
  validate <id>                    Fixture-validate and activate when healthy
  activate <id>                    Mark a valid credential routing-eligible
  quarantine <id>                  Stop leasing without deleting
  revoke <id> [--yes]              Revoke (admin/owner; others request approval)
  rotate <id> --secret <value> [--yes]
  disable <id>
  health [run|<id>]                Run the in-process health pass or one check
  lease --provider <slug> [--agent <id>] [--model <id>]
  release <lease-id>
  oauth start --provider <slug>
  oauth callback --state <s> --code <c>
  policy list|evaluate
  approve list|grant|deny|execute
  audit                            Immutable audit trail (secrets redacted)
  providers [enable|disable <slug>]

Options:
  --json                           Emit machine-readable JSON
  --yes                            Confirm a dangerous mutation
`);
    return 0;
  }

  const action = cleanArgs[1]?.toLowerCase();
  const readOnly =
    sub === "overview"
    || sub === "list"
    || sub === "show"
    || sub === "audit"
    || (sub === "providers" && (action === undefined || action === "list"))
    || (sub === "policy" && (action === undefined || action === "list" || action === "evaluate"))
    || (sub === "approve" && (action === undefined || action === "list"))
    || (sub === "health" && action !== "run")
    || (sub === "oauth" && (action === undefined || action === "list"));
  if (!readOnly && !service.enabled()) {
    const message = "Credential runtime is disabled. Set CREDENTIAL_RUNTIME_ENABLED=true.";
    if (json) printJson({ error: message });
    else console.error(message);
    return 1;
  }

  try {
    switch (sub) {
      case "overview": {
        const data = service.overview();
        if (json) printJson({ data });
        else {
          console.log(`Credential runtime: ${data.enabled ? "enabled" : "disabled (set CREDENTIAL_RUNTIME_ENABLED=true)"}`);
          console.log(`Total: ${data.total}`);
          console.log(`Healthy: ${data.healthy}`);
          console.log(`Degraded: ${data.degraded}`);
          console.log(`Quarantined: ${data.quarantined}`);
          console.log(`Revoked: ${data.revoked}`);
          console.log(`Active leases: ${data.active_leases}`);
          console.log(`Circuit open: ${data.circuit_open}`);
          console.log(`Vault: ${data.vault_available ? "available" : "unavailable"}`);
        }
        return 0;
      }

      case "list": {
        const provider = flagValue(cleanArgs, "--provider");
        const providerRow = provider
          ? (service.db.getProviderBySlug(provider) ?? service.db.getProvider(provider))
          : null;
        const rows = service.listPublic({ provider_id: providerRow?.id });
        if (json) printJson({ data: rows });
        else {
          console.log(`Credentials (${rows.length}):`);
          for (const row of rows) {
            console.log(`- ${row.id} [${row.status}/${row.health_status}] ${row.provider_slug} ${row.name} secret=${row.secret}`);
          }
        }
        return 0;
      }

      case "show": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx credentials show <id>"); return 1; }
        const row = service.db.getCredential(id);
        if (!row) { console.error(`Credential not found: ${id}`); return 1; }
        printJson({ credential: service.toPublicView(row) });
        return 0;
      }

      case "import": {
        const provider = flagValue(cleanArgs, "--provider");
        const name = flagValue(cleanArgs, "--name") ?? "cli-import";
        const secret = flagValue(cleanArgs, "--secret");
        if (!provider || !secret) {
          console.error("Usage: ocx credentials import --provider <slug> --name <n> --secret <value>");
          return 1;
        }
        const created = await service.importCredential({
          provider,
          name,
          secret,
          credential_type: (flagValue(cleanArgs, "--type") as CredentialType | undefined) ?? "api_key",
          environment: flagValue(cleanArgs, "--environment") ?? "local",
          actor: "cli",
          actor_role: (flagValue(cleanArgs, "--role") as CredentialRole | undefined) ?? "operator",
        });
        printJson({ credential: created });
        return 0;
      }

      case "validate": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx credentials validate <id>"); return 1; }
        printJson({ credential: await service.validateCredential(id, "cli") });
        return 0;
      }

      case "activate": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx credentials activate <id>"); return 1; }
        printJson({ credential: service.activateCredential(id, "cli") });
        return 0;
      }

      case "quarantine": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx credentials quarantine <id>"); return 1; }
        printJson({ credential: service.quarantineCredential(id, "cli", flagValue(cleanArgs, "--reason") ?? "cli") });
        return 0;
      }

      case "revoke": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx credentials revoke <id> [--yes]"); return 1; }
        if (!confirmDanger(cleanArgs)) {
          console.error("Refusing revoke without --yes");
          return 1;
        }
        printJson({ result: service.revokeCredential(id, "cli", (flagValue(cleanArgs, "--role") as CredentialRole | undefined) ?? "admin") });
        return 0;
      }

      case "rotate": {
        const id = cleanArgs[1];
        const secret = flagValue(cleanArgs, "--secret");
        if (!id || !secret) { console.error("Usage: ocx credentials rotate <id> --secret <value> [--yes]"); return 1; }
        if (!confirmDanger(cleanArgs)) {
          console.error("Refusing rotate without --yes");
          return 1;
        }
        printJson({
          result: await service.rotateCredential({
            credential_id: id,
            secret,
            actor: "cli",
            actor_role: (flagValue(cleanArgs, "--role") as CredentialRole | undefined) ?? "admin",
          }),
        });
        return 0;
      }

      case "disable": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx credentials disable <id>"); return 1; }
        printJson({ credential: service.disableCredential(id, "cli") });
        return 0;
      }

      case "health": {
        if (action === "run" || action === undefined) {
          if (action === "run") {
            printJson({ data: { checked: await service.runHealthPass() } });
            return 0;
          }
          const id = cleanArgs[1];
          if (!id) {
            const data = service.listPublic().map(row => ({
              id: row.id, health_status: row.health_status, health_score: row.health_score, status: row.status,
            }));
            printJson({ data });
            return 0;
          }
          printJson({ credential: await service.runHealthCheck(id) });
          return 0;
        }
        printJson({ credential: await service.runHealthCheck(action) });
        return 0;
      }

      case "lease": {
        const provider = flagValue(cleanArgs, "--provider");
        if (!provider) { console.error("Usage: ocx credentials lease --provider <slug>"); return 1; }
        const grant = service.acquireLease({
          requester_type: "cli",
          requester_id: "cli",
          agent_id: flagValue(cleanArgs, "--agent"),
          provider,
          model: flagValue(cleanArgs, "--model"),
          purpose: flagValue(cleanArgs, "--purpose") ?? "cli-lease",
          actor_role: "developer",
        });
        printJson({ lease: grant });
        return 0;
      }

      case "release": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx credentials release <lease-id>"); return 1; }
        printJson({ lease: service.releaseLease(id, "cli") });
        return 0;
      }

      case "oauth": {
        const verb = cleanArgs[1]?.toLowerCase();
        if (verb === "start") {
          const provider = flagValue(cleanArgs, "--provider");
          if (!provider) { console.error("Usage: ocx credentials oauth start --provider <slug>"); return 1; }
          printJson(await service.startOauth({ provider, actor: "cli" }));
          return 0;
        }
        if (verb === "callback") {
          const state = flagValue(cleanArgs, "--state");
          const code = flagValue(cleanArgs, "--code");
          if (!state || !code) { console.error("Usage: ocx credentials oauth callback --state <s> --code <c>"); return 1; }
          printJson({ credential: await service.completeOauth({ state, code, actor: "cli" }) });
          return 0;
        }
        printJson({ data: service.db.listOauth() });
        return 0;
      }

      case "policy": {
        const verb = cleanArgs[1]?.toLowerCase() ?? "list";
        if (verb === "list") {
          printJson({ data: service.db.listPolicies() });
          return 0;
        }
        if (verb === "evaluate") {
          const id = flagValue(cleanArgs, "--credential") ?? cleanArgs[2];
          if (!id) { console.error("Usage: ocx credentials policy evaluate --credential <id>"); return 1; }
          printJson({ decision: service.evaluatePolicy({ credential_id: id, action: "lease", actor_role: "developer" }) });
          return 0;
        }
        console.error(`Unknown policy action: ${verb}`);
        return 1;
      }

      case "approve": {
        const verb = cleanArgs[1]?.toLowerCase() ?? "list";
        if (verb === "list") {
          printJson({ data: service.db.listApprovals(cleanArgs[2]) });
          return 0;
        }
        const id = cleanArgs[2];
        if (!id) { console.error(`Usage: ocx credentials approve ${verb} <id>`); return 1; }
        if (verb === "grant" || verb === "approve") {
          printJson({ approval: service.decideApproval(id, "approved", "cli-reviewer") });
          return 0;
        }
        if (verb === "deny" || verb === "reject") {
          printJson({ approval: service.decideApproval(id, "rejected", "cli-reviewer") });
          return 0;
        }
        if (verb === "execute") {
          printJson({ result: service.executeApproval(id, "cli-reviewer") });
          return 0;
        }
        console.error(`Unknown approve action: ${verb}`);
        return 1;
      }

      case "audit": {
        printJson({ data: service.db.listAudit() });
        return 0;
      }

      case "providers": {
        const verb = cleanArgs[1]?.toLowerCase();
        if (!verb || verb === "list") {
          const rows = service.db.listProviders();
          if (json) printJson({ data: rows });
          else {
            console.log(`Providers (${rows.length}):`);
            for (const row of rows) console.log(`- ${row.slug} [${row.enabled ? "on" : "off"}] ${row.adapter_type}`);
          }
          return 0;
        }
        const slug = cleanArgs[2];
        if (!slug) { console.error(`Usage: ocx credentials providers ${verb} <slug>`); return 1; }
        if (verb === "enable") {
          printJson({ provider: service.setProviderEnabled(slug, true, "cli", "admin") });
          return 0;
        }
        if (verb === "disable") {
          printJson({ provider: service.setProviderEnabled(slug, false, "cli", "admin") });
          return 0;
        }
        console.error(`Unknown providers action: ${verb}`);
        return 1;
      }

      default:
        console.error(`Unknown credentials command: ${sub}`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ error: message });
    else console.error(message);
    return 1;
  }
}

