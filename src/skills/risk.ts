import type { RiskLevel, SkillRiskAssessment, SkillScanFinding } from "./types";

export const RULE_WEIGHTS: Record<string, number> = {
  // Remote execution & download
  "skill.shell.curl-pipe-sh": 35,
  "skill.shell.powershell-download-exec": 35,
  "skill.shell.encoded-payload": 30,

  // Destructive actions
  "skill.fs.destructive-remove": 30,
  "skill.git.destructive-action": 20,

  // Privilege & bypass
  "skill.privilege.elevation": 30,
  "skill.security.policy-bypass": 35,

  // Secrets & credentials
  "skill.credential.ssh-key": 25,
  "skill.credential.cloud-tokens": 25,
  "skill.credential.env-harvest": 15,
  "skill.credential.browser-profile": 25,

  // Exfiltration
  "skill.network.data-exfiltration": 30,
  "skill.messaging.send-external": 20,

  // Persistence & system changes
  "skill.persistence.scheduler-cron": 35,
  "skill.system.registry-firewall": 30,
  "skill.container.docker-socket": 35,

  // Hardware
  "skill.device.camera-mic": 20,
  "skill.device.clipboard": 15,

  // Basic commands
  "skill.shell.general-command": 8,
  "skill.package.system-install": 18,
  "skill.package.user-install": 12,
};

export function assessSkillRisk(findings: SkillScanFinding[]): SkillRiskAssessment {
  let totalScore = 0;
  const inferredCapabilitiesSet = new Set<string>();
  const rulesHit = new Set<string>();

  for (const f of findings) {
    rulesHit.add(f.rule_id);
    const weight = RULE_WEIGHTS[f.rule_id] ?? 10;
    // diminishing returns for repeated hits of the same rule
    const count = findings.filter(x => x.rule_id === f.rule_id).length;
    if (count > 1) {
      totalScore += Math.round(weight * 0.4);
    } else {
      totalScore += weight;
    }

    // Map rule to inferred capabilities
    if (f.rule_id.includes("shell") || f.rule_id.includes("package")) {
      inferredCapabilitiesSet.add("process.command.execute");
    }
    if (f.rule_id.includes("privilege")) {
      inferredCapabilitiesSet.add("process.privilege.elevated");
    }
    if (f.rule_id.includes("destructive") || f.rule_id.includes("fs")) {
      inferredCapabilitiesSet.add("filesystem.project.write");
    }
    if (f.rule_id.includes("credential")) {
      inferredCapabilitiesSet.add("secrets.read");
    }
    if (f.rule_id.includes("network") || f.rule_id.includes("messaging") || f.rule_id.includes("curl")) {
      inferredCapabilitiesSet.add("network.outbound");
    }
    if (f.rule_id.includes("exfiltration")) {
      inferredCapabilitiesSet.add("network.exfiltration");
    }
    if (f.rule_id.includes("persistence") || f.rule_id.includes("system")) {
      inferredCapabilitiesSet.add("system.persistence");
    }
    if (f.rule_id.includes("device") || f.rule_id.includes("clipboard")) {
      inferredCapabilitiesSet.add("device.access");
    }
    if (f.rule_id.includes("docker")) {
      inferredCapabilitiesSet.add("container.socket");
    }
  }

  // Hard Escalation Checks
  const hardEscalations: string[] = [];

  const hasSecretAccess = rulesHit.has("skill.credential.ssh-key") ||
    rulesHit.has("skill.credential.cloud-tokens") ||
    rulesHit.has("skill.credential.browser-profile") ||
    rulesHit.has("skill.credential.env-harvest");

  const hasUpload = rulesHit.has("skill.network.data-exfiltration") ||
    rulesHit.has("skill.messaging.send-external");

  if (hasSecretAccess && hasUpload) {
    hardEscalations.push("Combination of credential access and external upload capability");
    totalScore = Math.max(totalScore, 85);
  }

  const hasSudo = rulesHit.has("skill.privilege.elevation");
  const hasRemoteScript = rulesHit.has("skill.shell.curl-pipe-sh") ||
    rulesHit.has("skill.shell.powershell-download-exec");

  if (hasSudo && hasRemoteScript) {
    hardEscalations.push("Combination of privilege elevation (sudo) and remote script execution");
    totalScore = Math.max(totalScore, 90);
  }

  const hasBypass = rulesHit.has("skill.security.policy-bypass");
  const hasDestructive = rulesHit.has("skill.fs.destructive-remove") ||
    rulesHit.has("skill.git.destructive-action");

  if (hasBypass && hasDestructive) {
    hardEscalations.push("Combination of policy bypass instruction and destructive command");
    totalScore = Math.max(totalScore, 95);
  }

  if (rulesHit.has("skill.container.docker-socket") && rulesHit.has("skill.shell.general-command")) {
    hardEscalations.push("Combination of Docker socket access and arbitrary shell execution");
    totalScore = Math.max(totalScore, 90);
  }

  // Cap score at 100
  const score = Math.min(100, Math.max(0, totalScore));

  let level: RiskLevel = "low";
  if (score >= 75) {
    level = "critical";
  } else if (score >= 50) {
    level = "high";
  } else if (score >= 25) {
    level = "medium";
  }

  return {
    score,
    level,
    inferred_capabilities: Array.from(inferredCapabilitiesSet).sort(),
    findings,
    hard_escalations: hardEscalations,
  };
}

