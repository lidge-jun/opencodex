import { sha256 } from "./hasher";
import type { RiskLevel, SkillScanFinding } from "./types";

export interface ScannerRule {
  id: string;
  severity: RiskLevel;
  pattern: RegExp;
  message: string;
  category: string;
}

export const SCANNER_RULES: ScannerRule[] = [
  // 1. Critical Execution / Remote piping
  {
    id: "skill.shell.curl-pipe-sh",
    severity: "critical",
    pattern: /(curl|wget)[\s\S]{1,60}\|\s*(sh|bash|zsh|python|perl|ruby)/i,
    message: "Remote content is piped directly into a shell interpreter.",
    category: "remote_execution",
  },
  {
    id: "skill.shell.powershell-download-exec",
    severity: "critical",
    pattern: /(Invoke-Expression|iex|DownloadString|Net\.WebClient|Start-Process[\s\S]{1,30}http)/i,
    message: "PowerShell download-and-execute pattern detected.",
    category: "remote_execution",
  },
  {
    id: "skill.shell.encoded-payload",
    severity: "critical",
    pattern: /(base64\s+(-d|--decode)|from_base64|atob\s*\(|Buffer\.from\([^)]*base64)/i,
    message: "Base64 decode-and-execute or encoded payload indicator detected.",
    category: "evasion",
  },

  // 2. Destructive Operations
  {
    id: "skill.fs.destructive-remove",
    severity: "high",
    pattern: /(rm\s+-(rf|fr|r\s+-f|f\s+-r)\s+[\/\*]|del\s+\/[sfq]|rmdir\s+\/s|format\s+[a-z]:)/i,
    message: "Destructive recursive filesystem deletion or formatting command.",
    category: "destructive_filesystem",
  },
  {
    id: "skill.git.destructive-action",
    severity: "high",
    pattern: /(git\s+reset\s+--hard|git\s+clean\s+-(fd|df|xdf)|git\s+push[\s\S]{1,20}--force)/i,
    message: "Destructive Git command (hard reset, clean, or force push) detected.",
    category: "destructive_git",
  },

  // 3. Privilege Elevation & Security Bypass
  {
    id: "skill.privilege.elevation",
    severity: "high",
    pattern: /(sudo\s+|runas\s+\/user|doas\s+|su\s+-)/i,
    message: "Privilege elevation command (sudo / runas / doas) detected.",
    category: "privilege_elevation",
  },
  {
    id: "skill.security.policy-bypass",
    severity: "critical",
    pattern: /(ignore\s+(all\s+)?(security|safety|policy|instructions)|bypass\s+(safety|guardrails)|disable\s+(security|firewall|antivirus)|jailbreak)/i,
    message: "Instruction explicitly attempts to bypass safety policy, security controls, or system guardrails.",
    category: "security_bypass",
  },

  // 4. Secret & Credential Access
  {
    id: "skill.credential.ssh-key",
    severity: "high",
    pattern: /(\.ssh\/(id_rsa|id_ed25519|id_ecdsa|authorized_keys|known_hosts)|ssh-add)/i,
    message: "Direct reference or access to SSH private keys or authentication files.",
    category: "credential_access",
  },
  {
    id: "skill.credential.cloud-tokens",
    severity: "high",
    pattern: /(\.aws\/credentials|\.azure\/|\.gcloud\/|service-account\.json|gcloud\s+auth)/i,
    message: "Reference to cloud provider credentials or service account tokens.",
    category: "credential_access",
  },
  {
    id: "skill.credential.env-harvest",
    severity: "medium",
    pattern: /(printenv|env\s*\|\s*grep|export\s+[A-Z_]+=|cat\s+\.env|process\.env)/i,
    message: "Instruction harvests or dumps system environment variables or .env files.",
    category: "credential_access",
  },
  {
    id: "skill.credential.browser-profile",
    severity: "high",
    pattern: /(Cookies|Login\s+Data|Default\/Network|Google\/Chrome\/User\s+Data|Mozilla\/Firefox\/Profiles)/i,
    message: "Access to browser user profiles, session cookies, or saved credentials.",
    category: "credential_access",
  },

  // 5. Exfiltration & External Uploads
  {
    id: "skill.network.data-exfiltration",
    severity: "critical",
    pattern: /(curl[\s\S]{1,80}(-d|--data|--upload-file|-T|-F)\b|curl[\s\S]{1,80}-X\s*(POST|PUT)|(curl|wget)[\s\S]{1,80}https?:\/\/[\s\S]{1,80}(-d|--data|--upload-file|-T|-F)\b|nc\s+-[lve]|ncat\s+|ngrok\s+http)/i,
    message: "Potential data exfiltration via external HTTP POST, upload file, or reverse netcat tunnel.",
    category: "data_exfiltration",
  },
  {
    id: "skill.messaging.send-external",
    severity: "medium",
    pattern: /(sendmail|mailx|discord\.com\/api\/webhooks|hooks\.slack\.com\/services)/i,
    message: "Instruction sends messages or posts data to external webhooks or mail endpoints.",
    category: "network",
  },

  // 6. Persistence & System Modification
  {
    id: "skill.persistence.scheduler-cron",
    severity: "high",
    pattern: /(crontab\s+-[eulr]|\/etc\/cron|schtasks\s+\/create|systemctl\s+(enable|start)|launchctl\s+load)/i,
    message: "Creation of scheduled tasks, cron jobs, or persistent system services.",
    category: "persistence",
  },
  {
    id: "skill.system.registry-firewall",
    severity: "high",
    pattern: /(reg\s+(add|delete)|netsh\s+advfirewall|iptables\s+-[AI]|ufw\s+(allow|disable))/i,
    message: "Instruction alters system registry or network firewall configuration.",
    category: "system_modification",
  },
  {
    id: "skill.container.docker-socket",
    severity: "critical",
    pattern: /(\/var\/run\/docker\.sock|--privileged|cap-add=ALL)/i,
    message: "Docker socket access or privileged container execution indicator.",
    category: "container_escape",
  },

  // 7. Device Access & Clipboard
  {
    id: "skill.device.camera-mic",
    severity: "medium",
    pattern: /(getUserMedia|arecord|ffmpeg[\s\S]{1,20}(video|audio|webcam|microphone)|avfoundation)/i,
    message: "Hardware device access (camera, microphone, or audio capture) detected.",
    category: "device_access",
  },
  {
    id: "skill.device.clipboard",
    severity: "medium",
    pattern: /(pbpaste|pbcopy|xclip|xsel|Get-Clipboard|Set-Clipboard)/i,
    message: "System clipboard access detected.",
    category: "device_access",
  },

  // 8. General Shell & Package Commands
  {
    id: "skill.shell.general-command",
    severity: "low",
    pattern: /(```(bash|sh|shell|zsh|powershell|cmd)\b|`\s*(bash|sh|node|python)\s+)/i,
    message: "Contains shell execution or script instructions.",
    category: "process_execution",
  },
  {
    id: "skill.package.system-install",
    severity: "medium",
    pattern: /(apt-get\s+install|yum\s+install|brew\s+install|dnf\s+install|pacman\s+-S|choco\s+install)/i,
    message: "Instructions to install host-wide system packages.",
    category: "package_management",
  },
  {
    id: "skill.package.user-install",
    severity: "low",
    pattern: /(npm\s+(i|install)|pip\s+install|cargo\s+install|gem\s+install)/i,
    message: "Package manager installation command detected.",
    category: "package_management",
  },
];

/**
 * Scan text content (SKILL.md or bundled file) against deterministic security rules.
 */
export function scanSkillText(content: string, filePath = "SKILL.md"): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = content.split("\n");

  for (const rule of SCANNER_RULES) {
    // Check line by line to accurately identify line numbers
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (rule.pattern.test(line)) {
        const evidence = line.trim();
        findings.push({
          rule_id: rule.id,
          severity: rule.severity,
          file_path: filePath,
          line_start: i + 1,
          line_end: i + 1,
          evidence_hash: sha256(evidence),
          message: rule.message,
          metadata: {
            category: rule.category,
            snippet: evidence.slice(0, 200), // bounded snippet, no full text
          },
        });
      }
    }
  }

  return findings;
}

/**
 * Scan an entire Skill package (entry file + bundled reference files).
 */
export function scanSkillPackage(
  entryContent: string,
  bundledFiles: Record<string, string | Buffer> = {},
  entryFileName = "SKILL.md",
): { findings: SkillScanFinding[]; scannerVersion: string } {
  const findings: SkillScanFinding[] = [];

  // 1. Scan entry file
  findings.push(...scanSkillText(entryContent, entryFileName));

  // 2. Scan bundled text files
  for (const [relPath, content] of Object.entries(bundledFiles)) {
    if (typeof content === "string") {
      findings.push(...scanSkillText(content, relPath));
    } else if (Buffer.isBuffer(content)) {
      // If it looks like text, scan it
      const text = content.toString("utf8");
      // basic binary check: contains null bytes
      if (!text.includes("\0")) {
        findings.push(...scanSkillText(text, relPath));
      }
    }
  }

  return {
    findings,
    scannerVersion: "1.0.0",
  };
}

