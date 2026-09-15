import { getSecurityControlService } from "../security";
import { isJsonOption } from "./runtime-api";
import type { ApprovalDecisionKind, SevenQuestionAnswers } from "../security/types";

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

export async function runSecurity(args: string[]): Promise<number> {
  const json = args.some(a => typeof a === "string" && isJsonOption(a));
  const cleanArgs = args.filter(a => typeof a === "string" && !isJsonOption(a));
  const sub = cleanArgs[0]?.toLowerCase();
  const service = getSecurityControlService();

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    if (json) {
      printJson({
        commands: [
          "overview", "auth", "scope", "campaign", "lead", "finding",
          "approve", "validate", "report", "import", "audit", "evaluate",
        ],
      });
      return 0;
    }
    console.log(`Usage: ocx security <command> [options]

Authorized Security Agent Control Plane (Pao-hubPro × Agentic Bug Hunter)

Target-facing work is deny-by-default. Live third-party recon is not invoked.
Set PAO_SECURITY_CONTROL_PLANE=true before mutating campaigns.

Commands:
  overview                         Control-plane counts and breaker state
  auth list|show|create|verify     Authorization records
  scope list|show|create|verify    Scope registry
  campaign list|show|create|start|pause|resume|cancel|recon
  lead list                        Campaign lead board
  finding list|promote|show        Findings (validated only after the seven-question gate)
  approve list|grant|deny          Human approval gate
  validate <finding-id>            Run the seven-question validation gate
  report <campaign-id>             Export validated findings
  import <path>                    Static inventory of an imported package (never executes)
  audit [campaign-id]              Immutable audit trail
  evaluate                         Policy evaluation (capability + target)

Options:
  --json                           Emit machine-readable JSON
`);
    return 0;
  }

  const action = cleanArgs[1]?.toLowerCase();
  const readOnly =
    sub === "overview"
    || sub === "audit"
    || sub === "evaluate"
    || sub === "lead"
    || ((sub === "auth" || sub === "scope" || sub === "campaign") && (action === undefined || action === "list" || action === "show"))
    || (sub === "finding" && (action === undefined || action === "list" || action === "show"))
    || (sub === "approve" && (action === undefined || action === "list"));
  if (!readOnly && !service.enabled()) {
    const message = "Security control plane is disabled. Set PAO_SECURITY_CONTROL_PLANE=true.";
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
          console.log(`Security control plane: ${data.enabled ? "enabled" : "disabled (set PAO_SECURITY_CONTROL_PLANE=true)"}`);
          console.log(`Campaigns active: ${data.campaigns_active}`);
          console.log(`Approvals pending: ${data.approvals_pending}`);
          console.log(`Leads open: ${data.leads_open}`);
          console.log(`Findings validated: ${data.findings_validated}`);
          console.log(`Blocked actions: ${data.blocked_actions}`);
          console.log(`Authorizations expiring: ${data.authorizations_expiring}`);
          console.log(`Circuit breakers open: ${data.circuit_breakers_open}`);
        }
        return 0;
      }

      case "auth": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          const rows = service.db.listAuthorizations();
          if (json) printJson({ data: rows });
          else {
            console.log(`Authorizations (${rows.length}):`);
            for (const row of rows) console.log(`- ${row.id} [${row.status}] ${row.type} ${row.valid_from} → ${row.valid_until}`);
          }
          return 0;
        }
        if (action === "show") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx security auth show <id>"); return 1; }
          const row = service.db.getAuthorization(id);
          if (!row) { console.error(`Authorization not found: ${id}`); return 1; }
          printJson({ authorization: row });
          return 0;
        }
        if (action === "create") {
          const created = service.createAuthorization({
            type: "lab",
            source_reference: cleanArgs[2] ?? "cli-lab",
            valid_from: new Date().toISOString(),
            valid_until: new Date(Date.now() + 7 * 86400_000).toISOString(),
            allowed_action_classes: ["asset_discovery", "fingerprinting", "controlled_validation"],
            created_by: "cli",
          });
          printJson({ authorization: created });
          return 0;
        }
        if (action === "verify") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx security auth verify <id>"); return 1; }
          printJson({ authorization: service.verifyAuthorization(id, "cli") });
          return 0;
        }
        console.error(`Unknown auth action: ${action}`);
        return 1;
      }

      case "scope": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          const rows = service.db.listScopes();
          if (json) printJson({ data: rows });
          else {
            console.log(`Scopes (${rows.length}):`);
            for (const row of rows) console.log(`- ${row.id} [${row.status}] ${row.name}`);
          }
          return 0;
        }
        if (action === "show") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx security scope show <id>"); return 1; }
          const row = service.db.getScope(id);
          if (!row) { console.error(`Scope not found: ${id}`); return 1; }
          printJson({ scope: row, assets: service.db.listAssets(id), exclusions: service.db.listExclusions(id) });
          return 0;
        }
        if (action === "verify") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx security scope verify <id>"); return 1; }
          printJson({ scope: service.verifyScope(id, "cli") });
          return 0;
        }
        if (action === "create") {
          const authId = cleanArgs[2];
          const name = cleanArgs[3];
          if (!authId || !name) { console.error("Usage: ocx security scope create <authorization-id> <name>"); return 1; }
          printJson({ scope: service.createScope({ authorization_id: authId, name, created_by: "cli" }) });
          return 0;
        }
        console.error(`Unknown scope action: ${action}`);
        return 1;
      }

      case "campaign": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          const rows = service.db.listCampaigns();
          if (json) printJson({ data: rows });
          else {
            console.log(`Campaigns (${rows.length}):`);
            for (const row of rows) console.log(`- ${row.id} [${row.status}] ${row.name}`);
          }
          return 0;
        }
        if (action === "show") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx security campaign show <id>"); return 1; }
          const row = service.db.getCampaign(id);
          if (!row) { console.error(`Campaign not found: ${id}`); return 1; }
          printJson({ campaign: row });
          return 0;
        }
        if (action === "create") {
          const name = cleanArgs[2];
          const authId = flagValue(cleanArgs, "--auth") ?? cleanArgs[3];
          const scopeId = flagValue(cleanArgs, "--scope") ?? cleanArgs[4];
          if (!name || !authId || !scopeId) {
            console.error("Usage: ocx security campaign create <name> --auth <id> --scope <id>");
            return 1;
          }
          printJson({ campaign: service.createCampaign({ name, authorization_id: authId, scope_id: scopeId, owner_id: "cli" }) });
          return 0;
        }
        if (action === "start" || action === "pause" || action === "resume" || action === "cancel") {
          const id = cleanArgs[2];
          if (!id) { console.error(`Usage: ocx security campaign ${action} <id>`); return 1; }
          const row = action === "start" ? service.startCampaign(id, "cli")
            : action === "pause" ? service.pauseCampaign(id, "cli")
              : action === "resume" ? service.resumeCampaign(id, "cli")
                : service.cancelCampaign(id, "cli");
          printJson({ campaign: row });
          return 0;
        }
        if (action === "recon") {
          const id = cleanArgs[2];
          const target = cleanArgs[3];
          if (!id || !target) { console.error("Usage: ocx security campaign recon <id> <target>"); return 1; }
          printJson({ result: service.runPassiveRecon(id, target, "cli") });
          return 0;
        }
        console.error(`Unknown campaign action: ${action}`);
        return 1;
      }

      case "lead": {
        const campaignId = cleanArgs[2] ?? cleanArgs[1];
        if (!campaignId || cleanArgs[1] === "list" && !cleanArgs[2]) {
          if (cleanArgs[1] && cleanArgs[1] !== "list") {
            printJson({ data: service.db.listLeads(cleanArgs[1]) });
            return 0;
          }
          console.error("Usage: ocx security lead list <campaign-id>");
          return 1;
        }
        printJson({ data: service.db.listLeads(campaignId) });
        return 0;
      }

      case "finding": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          printJson({ data: service.db.listFindings(cleanArgs[2]) });
          return 0;
        }
        if (action === "show") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx security finding show <id>"); return 1; }
          const row = service.db.getFinding(id);
          if (!row) { console.error(`Finding not found: ${id}`); return 1; }
          printJson({ finding: row });
          return 0;
        }
        if (action === "promote") {
          const leadId = cleanArgs[2];
          if (!leadId) { console.error("Usage: ocx security finding promote <lead-id>"); return 1; }
          printJson({ finding: service.promoteLeadToFinding(leadId, "cli") });
          return 0;
        }
        console.error(`Unknown finding action: ${action}`);
        return 1;
      }

      case "approve": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          printJson({ data: service.db.listApprovals(cleanArgs[2]) });
          return 0;
        }
        if (action === "grant" || action === "deny") {
          const id = cleanArgs[2];
          if (!id) { console.error(`Usage: ocx security approve ${action} <id>`); return 1; }
          const decision: ApprovalDecisionKind = action === "grant" ? "APPROVE_ONCE" : "DENY";
          printJson({ approval: service.decideApprovalRequest(id, decision, "cli-reviewer", action) });
          return 0;
        }
        console.error(`Unknown approve action: ${action}`);
        return 1;
      }

      case "validate": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx security validate <finding-id>"); return 1; }
        const pass = !cleanArgs.includes("--fail");
        const answers: SevenQuestionAnswers = {
          scope: pass, reality: pass, reproducibility: pass, impact: pass, evidence: pass, novelty: pass, policy: pass,
        };
        printJson({ finding: service.validateFinding(id, answers, "cli-reviewer", pass ? "seven-question pass" : "forced fail") });
        return 0;
      }

      case "report": {
        const id = cleanArgs[1];
        if (!id) { console.error("Usage: ocx security report <campaign-id>"); return 1; }
        const report = service.exportReport(id, "cli");
        if (json) printJson({ report });
        else console.log(report.markdown);
        return 0;
      }

      case "import": {
        const path = cleanArgs[1];
        if (!path) { console.error("Usage: ocx security import <path>"); return 1; }
        printJson({ package: service.importPackage(path, "cli") });
        return 0;
      }

      case "audit": {
        printJson({ data: service.db.listAudit(cleanArgs[1]) });
        return 0;
      }

      case "evaluate": {
        const capability = flagValue(cleanArgs, "--capability") ?? cleanArgs[1];
        const target = flagValue(cleanArgs, "--target") ?? cleanArgs[2];
        const campaign = flagValue(cleanArgs, "--campaign");
        if (!capability || !target) {
          console.error("Usage: ocx security evaluate --capability <id> --target <asset> [--campaign <id>]");
          return 1;
        }
        printJson({ decision: service.evaluate({ capability_id: capability, target, campaign_id: campaign, actor_id: "cli" }) });
        return 0;
      }

      default:
        console.error(`Unknown security command: ${sub}`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ error: message });
    else console.error(message);
    return 1;
  }
}
