import { getSocialPublishingService } from "../social";
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

export async function runSocial(args: string[]): Promise<number> {
  const json = args.some(a => typeof a === "string" && isJsonOption(a));
  const cleanArgs = args.filter(a => typeof a === "string" && !isJsonOption(a));
  const sub = cleanArgs[0]?.toLowerCase();
  const service = getSocialPublishingService();

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    if (json) {
      printJson({
        commands: [
          "overview", "instances", "accounts", "publications", "create",
          "renditions", "validate", "approve", "reject", "schedule",
          "publish", "cancel", "reconcile", "jobs", "analytics", "audit",
        ],
      });
      return 0;
    }
    console.log(`Usage: ocx social <command> [options]

Social Publishing Control Plane (Pao-hubPro × OpenPost)

Orchestrate cross-platform social publications, multi-account renditions,
approval workflows, durable scheduling, and analytics across OpenPost instances.
Set SOCIAL_PUBLISHING_ENABLED=true before mutating publications.

Commands:
  overview                         Control-plane counts and instance health
  instances [list|register|test|sync] Manage OpenPost backend instances
  accounts [list|refresh <id>]     Synced platform accounts and readiness
  publications [list|show <id>]    Master publication inventory and details
  create --type <text|image|video> --title <t> --caption <c> [--tags <a,b>]
  renditions <pub-id> --accounts <id1,id2> Generate target account renditions
  validate <pub-id>                Evaluate policy and capabilities
  approve <pub-id> [--scope <all|rendition>] Grant human approval
  reject <pub-id> [--reason <msg>] Reject publication
  schedule <pub-id> --time <iso>   Dispatch scheduled delivery to OpenPost
  publish <pub-id>                 Dispatch immediate publication
  cancel <pub-id>                  Cancel scheduled publication
  reconcile <pub-id>               Sync remote delivery state from OpenPost
  jobs [list|retry <id>]           Delivery queue jobs and retry state
  analytics <account-id> [pub-id]  Capture normalized engagement metrics
  audit                            Append-only audit trail

Options:
  --json                           Emit machine-readable JSON
  --yes                            Confirm high-impact mutation
`);
    return 0;
  }

  const mutatingCommands = new Set([
    "create", "renditions", "validate", "approve", "reject",
    "schedule", "publish", "cancel", "reconcile",
  ]);

  if (mutatingCommands.has(sub) && !service.enabled()) {
    const message = "Social publishing control plane is disabled. Set SOCIAL_PUBLISHING_ENABLED=true.";
    if (json) printJson({ error: message });
    else console.error(message);
    return 1;
  }

  try {
    switch (sub) {
      case "overview": {
        const data = service.getOverview();
        if (json) printJson({ data });
        else {
          console.log(`Social publishing: ${data.enabled ? "enabled" : "disabled (set SOCIAL_PUBLISHING_ENABLED=true)"}`);
          console.log(`Instances: ${data.instances_count}`);
          console.log(`Accounts: ${data.accounts_count} (${data.ready_accounts_count} ready)`);
          console.log(`Publications: ${data.publications_count} (${data.scheduled_count} scheduled)`);
          console.log(`Pending approvals: ${data.pending_approvals_count}`);
          console.log(`Failed deliveries: ${data.failed_deliveries_count}`);
        }
        return 0;
      }

      case "instances": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          const rows = service.db.listInstances();
          if (json) printJson({ data: rows });
          else {
            console.log(`OpenPost Instances (${rows.length}):`);
            for (const r of rows) console.log(`- ${r.id} [${r.status}] ${r.name} (${r.base_url})`);
          }
          return 0;
        }
        if (action === "register") {
          const name = flagValue(cleanArgs, "--name") ?? "OpenPost Instance";
          const baseUrl = flagValue(cleanArgs, "--base-url") ?? flagValue(cleanArgs, "--url");
          if (!baseUrl) {
            console.error("Usage: ocx social instances register --name <n> --base-url <url> [--secret-ref <ref>] [--id <id>]");
            return 1;
          }
          const id = flagValue(cleanArgs, "--id") ?? `inst_${Date.now()}`;
          const secretRef = flagValue(cleanArgs, "--secret-ref") ?? `secret://openpost/${id}/token`;
          const inst = await service.registerInstance({
            id,
            name,
            base_url: baseUrl,
            secret_ref: secretRef,
            actor: "cli",
          });
          printJson({ instance: inst });
          return 0;
        }
        if (action === "test") {
          const id = cleanArgs[2] ?? "main";
          const health = await service.testInstance(id);
          printJson({ health });
          return 0;
        }
        if (action === "sync") {
          const id = cleanArgs[2] ?? "main";
          const accounts = await service.syncAccounts(id, "cli");
          printJson({ accounts });
          return 0;
        }
        console.error(`Unknown instances action: ${action}`);
        return 1;
      }

      case "accounts": {
        const action = cleanArgs[1]?.toLowerCase();
        if (!action || action === "list") {
          const rows = service.db.listAccounts();
          if (json) printJson({ data: rows });
          else {
            console.log(`Connected Accounts (${rows.length}):`);
            for (const r of rows) console.log(`- ${r.id} [${r.platform}/${r.readiness_state}] ${r.display_name ?? r.username}`);
          }
          return 0;
        }
        if (action === "refresh") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx social accounts refresh <id>"); return 1; }
          const acc = service.db.getAccount(id);
          if (!acc) { console.error(`Account not found: ${id}`); return 1; }
          const provider = service.getProvider(acc.openpost_instance_id);
          const caps = await provider.getAccountCapabilities(acc.openpost_account_ref);
          acc.capabilities = caps;
          acc.capability_json = JSON.stringify(caps);
          acc.last_sync_at = new Date().toISOString();
          service.db.upsertAccount(acc);
          printJson({ account: acc });
          return 0;
        }
        console.error(`Unknown accounts action: ${action}`);
        return 1;
      }

      case "publications": {
        const action = cleanArgs[1]?.toLowerCase();
        if (!action || action === "list") {
          const rows = service.db.listPublications();
          if (json) printJson({ data: rows });
          else {
            console.log(`Publications (${rows.length}):`);
            for (const r of rows) console.log(`- ${r.id} [${r.status}] ${r.master_title ?? r.master_caption?.slice(0, 30)}`);
          }
          return 0;
        }
        if (action === "show") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx social publications show <id>"); return 1; }
          const pub = service.db.getPublication(id);
          if (!pub) { console.error(`Publication not found: ${id}`); return 1; }
          const renditions = service.db.listRenditions(id);
          const assets = service.db.listAssets(id);
          const approvals = service.db.listApprovals(id);
          printJson({ publication: pub, renditions, assets, approvals });
          return 0;
        }
        console.error(`Unknown publications action: ${action}`);
        return 1;
      }

      case "create": {
        const type = (flagValue(cleanArgs, "--type") as any) ?? "text";
        const title = flagValue(cleanArgs, "--title");
        const caption = flagValue(cleanArgs, "--caption");
        const tags = flagValue(cleanArgs, "--tags")?.split(",").map(t => t.trim());
        const pub = service.createPublication({
          source_type: type,
          master_title: title,
          master_caption: caption,
          master_tags: tags,
          created_by_type: "human",
          created_by_id: "cli",
        });
        printJson({ publication: pub });
        return 0;
      }

      case "renditions": {
        const pubId = cleanArgs[1];
        const accountsStr = flagValue(cleanArgs, "--accounts");
        if (!pubId || !accountsStr) {
          console.error("Usage: ocx social renditions <pub-id> --accounts <id1,id2>");
          return 1;
        }
        const accountIds = accountsStr.split(",").map(s => s.trim());
        const renditions = service.generateRenditionsForPublication(pubId, accountIds);
        printJson({ renditions });
        return 0;
      }

      case "validate": {
        const pubId = cleanArgs[1];
        if (!pubId) { console.error("Usage: ocx social validate <pub-id>"); return 1; }
        const evaluation = service.validatePublication(pubId);
        printJson({ evaluation });
        return 0;
      }

      case "approve": {
        const pubId = cleanArgs[1];
        if (!pubId) { console.error("Usage: ocx social approve <pub-id>"); return 1; }
        const approval = service.approvePublication({
          publicationId: pubId,
          decision: "approved",
          approverId: "cli-operator",
          scope: (flagValue(cleanArgs, "--scope") as any) ?? "PUBLICATION_ALL_DESTINATIONS",
          note: flagValue(cleanArgs, "--note"),
        });
        printJson({ approval });
        return 0;
      }

      case "reject": {
        const pubId = cleanArgs[1];
        if (!pubId) { console.error("Usage: ocx social reject <pub-id>"); return 1; }
        const approval = service.approvePublication({
          publicationId: pubId,
          decision: "rejected",
          approverId: "cli-operator",
          note: flagValue(cleanArgs, "--reason") ?? "Rejected by operator",
        });
        printJson({ approval });
        return 0;
      }

      case "schedule": {
        const pubId = cleanArgs[1];
        const time = flagValue(cleanArgs, "--time");
        if (!pubId) { console.error("Usage: ocx social schedule <pub-id> [--time <iso>]"); return 1; }
        if (time) {
          service.updatePublication(pubId, { scheduled_at: time });
        }
        const result = await service.schedulePublication(pubId, "cli");
        printJson(result);
        return 0;
      }

      case "publish": {
        const pubId = cleanArgs[1];
        if (!pubId) { console.error("Usage: ocx social publish <pub-id>"); return 1; }
        const result = await service.publishNow(pubId, "cli");
        printJson(result);
        return 0;
      }

      case "cancel": {
        const pubId = cleanArgs[1];
        if (!pubId) { console.error("Usage: ocx social cancel <pub-id>"); return 1; }
        const pub = await service.cancelPublication(pubId, "cli");
        printJson({ publication: pub });
        return 0;
      }

      case "reconcile": {
        const pubId = cleanArgs[1];
        if (!pubId) { console.error("Usage: ocx social reconcile <pub-id>"); return 1; }
        const pub = await service.reconcilePublication(pubId);
        printJson({ publication: pub });
        return 0;
      }

      case "jobs": {
        const action = cleanArgs[1]?.toLowerCase();
        if (!action || action === "list") {
          const rows = service.db.listDeliveryJobs();
          if (json) printJson({ data: rows });
          else {
            console.log(`Delivery Jobs (${rows.length}):`);
            for (const r of rows) console.log(`- ${r.id} [${r.status}/${r.job_type}] attempts=${r.attempt_count}`);
          }
          return 0;
        }
        if (action === "retry") {
          const id = cleanArgs[2];
          if (!id) { console.error("Usage: ocx social jobs retry <id>"); return 1; }
          const job = service.db.listDeliveryJobs().find(j => j.id === id);
          if (!job) { console.error(`Job not found: ${id}`); return 1; }
          job.status = "pending";
          job.next_attempt_at = null;
          service.db.upsertDeliveryJob(job);
          printJson({ job });
          return 0;
        }
        console.error(`Unknown jobs action: ${action}`);
        return 1;
      }

      case "analytics": {
        const accountId = cleanArgs[1];
        const pubId = cleanArgs[2];
        if (!accountId) { console.error("Usage: ocx social analytics <account-id> [pub-id]"); return 1; }
        const snapshot = await service.syncAnalytics(accountId, pubId);
        printJson({ snapshot });
        return 0;
      }

      case "audit": {
        const events = service.db.listAuditEvents();
        printJson({ data: events });
        return 0;
      }

      default:
        console.error(`Unknown social command: ${sub}`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ error: message });
    else console.error(message);
    return 1;
  }
}

