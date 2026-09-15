import { getSkillControlService } from "../skills";
import { isJsonOption, takeFlag } from "./runtime-api";

export async function runSkill(args: string[]): Promise<number> {
  const json = args.some(a => typeof a === "string" && isJsonOption(a));
  const cleanArgs = args.filter(a => typeof a === "string" && !isJsonOption(a));
  const sub = cleanArgs[0]?.toLowerCase();
  const service = getSkillControlService();

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    if (json) {
      console.log(JSON.stringify({
        commands: [
          "list", "show", "search", "source", "import", "scan", "findings",
          "review", "publish", "quarantine", "revoke", "agent", "node",
          "deploy", "remove", "rollback", "sync", "drift", "update", "audit",
        ],
      }));
      return 0;
    }
    console.log(`Usage: ocx skill <command> [options]

Universal Agent Skill Control Plane (Pao-hubPro × SkillsGate)

Commands:
  list                          List all registered skills
  show <id>                     Show details for a skill
  search <query>                Search registry and marketplace
  source list|add               Manage skill sources
  import local|marketplace      Import a skill from local directory or marketplace
  scan <id>                     Run deterministic security scan on skill
  findings <id>                 Show security scan findings
  review <id>                   Request review / approval for a skill
  publish <id>                  Publish draft skill version (immutable)
  quarantine <id>               Quarantine a skill (blocks new deployments)
  revoke <id>                   Revoke a skill globally
  agent list|detect             List supported agents or detect installed agents
  node list|add|test            Manage and test local & remote nodes
  deploy <id> [options]         Deploy a skill (--agent, --scope, --dry-run)
  remove <deployment-id>        Remove a managed skill deployment
  rollback <deployment-id>      Roll back deployment to prior recovery snapshot
  sync <id> [options]           Synchronize skill across multiple agents
  drift check|show              Check or display deployment configuration drift
  update check|apply <id>       Check or apply skill version updates
  audit [id]                    Display skill audit trail

Options:
  --json                        Emit machine-readable JSON
  --agent <agent>               Target agent: codex, claude-code, opencode, universal
  --scope <scope>               Scope: user (default), project, workspace
  --dry-run                     Preview planned changes without writing to disk
`);
    return 0;
  }

  try {
    switch (sub) {
      case "list": {
        const skills = service.listSkills();
        if (json) {
          console.log(JSON.stringify({ data: skills }, null, 2));
        } else {
          console.log(`Registered Skills (${skills.length}):`);
          for (const s of skills) {
            console.log(`- ${s.id} (v${s.current_version}) [${s.status}] risk: ${s.risk_level ?? "none"} - ${s.display_name}`);
          }
        }
        return 0;
      }

      case "show": {
        const id = cleanArgs[1];
        if (!id) {
          console.error("Error: Missing skill id. Usage: ocx skill show <id>");
          return 1;
        }
        const skill = service.getSkill(id);
        if (!skill) {
          console.error(`Skill not found: ${id}`);
          return 1;
        }
        const versions = service.listSkillVersions(id);
        if (json) {
          console.log(JSON.stringify({ skill, versions }, null, 2));
        } else {
          console.log(`Skill: ${skill.display_name} (${skill.id})`);
          console.log(`Version: ${skill.current_version}`);
          console.log(`Status: ${skill.status} | Trust: ${skill.trust_level} | Risk: ${skill.risk_level ?? "unknown"}`);
          console.log(`Description: ${skill.description}`);
          console.log(`Tags: ${skill.tags.join(", ") || "none"}`);
          console.log(`Versions (${versions.length}): ${versions.map(v => v.version).join(", ")}`);
        }
        return 0;
      }

      case "search": {
        const query = cleanArgs.slice(1).join(" ");
        const local = service.searchSkills(query);
        const marketplace = await service.searchMarketplace(query);
        if (json) {
          console.log(JSON.stringify({ local, marketplace }, null, 2));
        } else {
          console.log(`Registry Results (${local.length}):`);
          for (const s of local) console.log(`  * ${s.id} (${s.display_name})`);
          console.log(`Marketplace Results (${marketplace.length}):`);
          for (const m of marketplace) console.log(`  * [marketplace] ${m.id} v${m.version} - ${m.name}: ${m.description}`);
        }
        return 0;
      }

      case "source": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          const sources = service.db.listSources();
          if (json) {
            console.log(JSON.stringify({ sources }, null, 2));
          } else {
            console.log(`Skill Sources (${sources.length}):`);
            for (const s of sources) console.log(`- ${s.id} (${s.display_name}) [${s.source_type}] enabled: ${s.enabled}`);
          }
          return 0;
        }
        if (action === "add") {
          const id = cleanArgs[2];
          const url = cleanArgs[3];
          if (!id) {
            console.error("Usage: ocx skill source add <id> [url]");
            return 1;
          }
          const now = new Date().toISOString();
          service.db.upsertSource({
            id,
            source_type: "GIT",
            display_name: id,
            repository_url: url,
            trust_level: "community",
            enabled: true,
            created_at: now,
            updated_at: now,
          });
          console.log(`Source added: ${id}`);
          return 0;
        }
        console.error(`Unknown source action: ${action}`);
        return 1;
      }

      case "import": {
        const type = cleanArgs[1]?.toLowerCase();
        const target = cleanArgs[2];
        if (!type || !target) {
          console.error("Usage: ocx skill import local <path> | marketplace <ref>");
          return 1;
        }
        if (type === "local") {
          const result = await service.importLocal(target);
          if (json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Successfully imported local skill: ${result.skill.id} (v${result.version.version}) [status: ${result.skill.status}]`);
          }
          return 0;
        }
        if (type === "marketplace") {
          const result = await service.importFromMarketplace(target);
          if (json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Successfully imported marketplace skill: ${result.skill.id} (v${result.version.version})`);
          }
          return 0;
        }
        console.error(`Unknown import type: ${type}`);
        return 1;
      }

      case "scan": {
        const id = cleanArgs[1];
        if (!id) {
          console.error("Usage: ocx skill scan <id>");
          return 1;
        }
        const skill = service.getSkill(id);
        if (!skill) {
          console.error(`Skill not found: ${id}`);
          return 1;
        }
        const res = service.scanSkill(`${id}@${skill.current_version}`);
        if (json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Scan completed for ${id}: Risk Score ${res.score}/100 [${res.level.toUpperCase()}]`);
          console.log(`Findings: ${res.findings.length}`);
          for (const f of res.findings) {
            console.log(`  - [${f.severity.toUpperCase()}] ${f.rule_id} (${f.file_path}:${f.line_start ?? 1}): ${f.message}`);
          }
        }
        return 0;
      }

      case "findings": {
        const id = cleanArgs[1];
        if (!id) {
          console.error("Usage: ocx skill findings <id>");
          return 1;
        }
        const skill = service.getSkill(id);
        if (!skill) {
          console.error(`Skill not found: ${id}`);
          return 1;
        }
        const findings = service.getFindings(`${id}@${skill.current_version}`);
        if (json) {
          console.log(JSON.stringify({ findings }, null, 2));
        } else {
          console.log(`Findings for ${id} (${findings.length}):`);
          for (const f of findings) {
            console.log(`  [${f.severity.toUpperCase()}] ${f.rule_id}: ${f.message}`);
          }
        }
        return 0;
      }

      case "review": {
        const id = cleanArgs[1];
        if (!id) {
          console.error("Usage: ocx skill review <id>");
          return 1;
        }
        const skill = service.getSkill(id);
        if (!skill) {
          console.error(`Skill not found: ${id}`);
          return 1;
        }
        const review = service.requestReview(`${id}@${skill.current_version}`, "cli-user");
        if (json) {
          console.log(JSON.stringify({ review }, null, 2));
        } else {
          console.log(`Review requested: ${review.id} for ${id} (status: ${review.status})`);
        }
        return 0;
      }

      case "publish": {
        const id = cleanArgs[1];
        if (!id) {
          console.error("Usage: ocx skill publish <id>");
          return 1;
        }
        const skill = service.getSkill(id);
        if (!skill) {
          console.error(`Skill not found: ${id}`);
          return 1;
        }
        const version = service.publishVersion(`${id}@${skill.current_version}`, "cli-user");
        if (json) {
          console.log(JSON.stringify({ version }, null, 2));
        } else {
          console.log(`Published ${id} v${version.version} successfully (now immutable)`);
        }
        return 0;
      }

      case "quarantine": {
        const id = cleanArgs[1];
        const reason = cleanArgs[2] ?? "Manual quarantine from CLI";
        if (!id) {
          console.error("Usage: ocx skill quarantine <id> [reason]");
          return 1;
        }
        const skill = service.quarantineSkill(id, reason, "cli-user");
        if (json) {
          console.log(JSON.stringify({ skill }, null, 2));
        } else {
          console.log(`Quarantined skill: ${skill.id}`);
        }
        return 0;
      }

      case "revoke": {
        const id = cleanArgs[1];
        const reason = cleanArgs[2] ?? "Manual revocation from CLI";
        if (!id) {
          console.error("Usage: ocx skill revoke <id> [reason]");
          return 1;
        }
        const skill = service.revokeSkill(id, reason, "cli-user");
        if (json) {
          console.log(JSON.stringify({ skill }, null, 2));
        } else {
          console.log(`Revoked skill: ${skill.id}`);
        }
        return 0;
      }

      case "agent": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          const agents = service.db.listAgents();
          if (json) {
            console.log(JSON.stringify({ agents }, null, 2));
          } else {
            console.log(`Configured Agents (${agents.length}):`);
            for (const a of agents) console.log(`- ${a.id}: ${a.display_name} (v${a.adapter_version})`);
          }
          return 0;
        }
        if (action === "detect") {
          const detected = await service.detectAgents();
          if (json) {
            console.log(JSON.stringify({ detected }, null, 2));
          } else {
            console.log(`Detected Agents (${detected.length}):`);
            for (const d of detected) console.log(`- ${d.agentType}: detected at ${d.configRoot ?? "system"}`);
          }
          return 0;
        }
        console.error(`Unknown agent action: ${action}`);
        return 1;
      }

      case "node": {
        const action = cleanArgs[1]?.toLowerCase() ?? "list";
        if (action === "list") {
          const nodes = service.listNodes();
          if (json) {
            console.log(JSON.stringify({ nodes }, null, 2));
          } else {
            console.log(`Remote Nodes (${nodes.length}):`);
            for (const n of nodes) console.log(`- ${n.name} (${n.kind}) [${n.status}] env: ${n.environment}`);
          }
          return 0;
        }
        if (action === "test") {
          const id = cleanArgs[2];
          if (!id) {
            console.error("Usage: ocx skill node test <node-id>");
            return 1;
          }
          const res = await service.testNodeConnection(id);
          if (json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(`Node ${id} connection: ${res.connected ? "SUCCESS" : "FAILED"}`);
            if (res.error) console.log(`Error: ${res.error}`);
          }
          return 0;
        }
        console.error(`Unknown node action: ${action}`);
        return 1;
      }

      case "deploy": {
        const id = cleanArgs[1];
        if (!id) {
          console.error("Usage: ocx skill deploy <id> [--agent <agent>] [--scope <scope>] [--dry-run]");
          return 1;
        }
        const skill = service.getSkill(id);
        if (!skill) {
          console.error(`Skill not found: ${id}`);
          return 1;
        }

        let agentType = "codex";
        let scope: any = "user";
        let dryRun = false;

        for (let i = 2; i < cleanArgs.length; i++) {
          if (cleanArgs[i] === "--agent" && cleanArgs[i + 1]) agentType = cleanArgs[++i]!;
          if (cleanArgs[i] === "--scope" && cleanArgs[i + 1]) scope = cleanArgs[++i]!;
          if (cleanArgs[i] === "--dry-run") dryRun = true;
        }

        const versionId = `${id}@${skill.current_version}`;
        if (dryRun) {
          const plan = await service.planDeployment(versionId, { agentType, scope, nodeId: "local" });
          if (json) {
            console.log(JSON.stringify({ plan }, null, 2));
          } else {
            console.log(`Deployment Plan for ${id} to ${agentType} (${scope}):`);
            console.log(`Target path: ${plan.target.targetPath}`);
            console.log(`Policy: ${plan.policyDecision.effect} (${plan.policyDecision.reason})`);
            console.log(`Requires Approval: ${plan.requiresApproval}`);
            console.log(`Actions:`);
            for (const a of plan.actions) console.log(`  [${a.action}] ${a.relativePath}`);
          }
          return 0;
        }

        const res = await service.deployDirect(versionId, { agentType, scope, nodeId: "local" });
        if (json) {
          console.log(JSON.stringify({ result: res }, null, 2));
        } else {
          console.log(`Deployed ${id} to ${agentType} at ${res.target.targetPath} (status: ${res.status})`);
        }
        return 0;
      }

      case "remove": {
        const depId = cleanArgs[1];
        if (!depId) {
          console.error("Usage: ocx skill remove <deployment-id>");
          return 1;
        }
        const res = await service.removeDeployment(depId);
        if (json) {
          console.log(JSON.stringify({ result: res }, null, 2));
        } else {
          console.log(`Removed deployment ${depId} (status: ${res.status})`);
        }
        return 0;
      }

      case "rollback": {
        const depId = cleanArgs[1];
        if (!depId) {
          console.error("Usage: ocx skill rollback <deployment-id>");
          return 1;
        }
        const res = await service.rollbackDeployment(depId);
        if (json) {
          console.log(JSON.stringify({ result: res }, null, 2));
        } else {
          console.log(`Rolled back deployment ${depId} to snapshot (status: ${res.status})`);
        }
        return 0;
      }

      case "sync": {
        const id = cleanArgs[1];
        if (!id) {
          console.error("Usage: ocx skill sync <id> [--from <agent>] [--to <targets>]");
          return 1;
        }
        let fromAgent = "codex";
        let toAgents = ["claude-code", "opencode"];
        for (let i = 2; i < cleanArgs.length; i++) {
          if (cleanArgs[i] === "--from" && cleanArgs[i + 1]) fromAgent = cleanArgs[++i]!;
          if (cleanArgs[i] === "--to" && cleanArgs[i + 1]) toAgents = cleanArgs[++i]!.split(",");
        }
        const results = await service.syncSkill(id, fromAgent, toAgents);
        if (json) {
          console.log(JSON.stringify({ results }, null, 2));
        } else {
          console.log(`Synced ${id} to ${toAgents.join(", ")}: ${results.length} targets updated.`);
        }
        return 0;
      }

      case "drift": {
        const action = cleanArgs[1]?.toLowerCase() ?? "check";
        if (action === "check") {
          const all = await service.checkAllDrift();
          if (json) {
            console.log(JSON.stringify({ drift: all }, null, 2));
          } else {
            console.log(`Drift Check Results (${all.length} deployments):`);
            for (const d of all) {
              console.log(`- ${d.skillId} @ ${d.targetPath}: ${d.inSync ? "IN_SYNC" : d.driftType}`);
            }
          }
          return 0;
        }
        console.error(`Unknown drift action: ${action}`);
        return 1;
      }

      case "update": {
        const action = cleanArgs[1]?.toLowerCase() ?? "check";
        if (action === "check") {
          const skills = service.listSkills();
          const updates = [];
          for (const s of skills) {
            const u = await service.checkSkillUpdates(s.id);
            updates.push(...u);
          }
          if (json) {
            console.log(JSON.stringify({ updates }, null, 2));
          } else {
            console.log(`Update Checks (${updates.length}):`);
            for (const u of updates) {
              console.log(`- ${u.skillId}: ${u.updateAvailable ? `UPDATE AVAILABLE (v${u.currentVersion} -> v${u.latestVersion})` : "UP TO DATE"}`);
            }
          }
          return 0;
        }
        console.error(`Unknown update action: ${action}`);
        return 1;
      }

      case "audit": {
        const events = service.listAuditEvents();
        if (json) {
          console.log(JSON.stringify({ audit: events }, null, 2));
        } else {
          console.log(`Audit Trail (${events.length} events):`);
          for (const ev of events.slice(0, 20)) {
            console.log(`[${ev.created_at}] ${ev.event_type} (${ev.actor_type}) target: ${ev.skill_id ?? ev.deployment_id ?? "system"}`);
          }
        }
        return 0;
      }

      default: {
        console.error(`Unknown skill command: ${sub}. Run "ocx skill help" for usage.`);
        return 1;
      }
    }
  } catch (error) {
    if (json) {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

