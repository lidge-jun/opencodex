import { isAbsolute, normalize, posix } from "node:path";
import type { AgentSkillManifest } from "./types";

export interface SkillValidationLimits {
  maxFiles: number;
  maxSingleFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_SKILL_LIMITS: SkillValidationLimits = {
  maxFiles: 500,
  maxSingleFileBytes: 10 * 1024 * 1024, // 10MB
  maxTotalBytes: 50 * 1024 * 1024,      // 50MB
};

export interface ValidationIssue {
  field: string;
  message: string;
  fatal: boolean;
}

export interface SkillValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/** Check if a relative path attempts traversal or absolute escape. */
export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") return false;

  // Reject URL encoded traversal e.g. %2e%2e
  const decoded = decodeURIComponent(relPath).split("\\").join("/");

  if (isAbsolute(decoded)) return false;
  if (/^[a-zA-Z]:/.test(decoded)) return false; // Windows drive letters
  if (decoded.startsWith("/")) return false;
  if (decoded.startsWith("//") || decoded.startsWith("\\\\")) return false; // UNC path

  // Check path segments for ..
  const parts = decoded.split("/");
  for (const part of parts) {
    if (part === ".." || part === ".") return false;
  }

  // Normalized path should not start with ..
  const norm = posix.normalize(decoded);
  if (norm.startsWith("../") || norm === ".." || isAbsolute(norm)) return false;

  return true;
}

/** Safe parser for Markdown YAML frontmatter without external eval. */
export function parseSkillFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const rawFm = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim();
  const frontmatter: Record<string, string> = {};

  const lines = rawFm.split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      // Remove surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/**
 * Validate skill files and manifest.
 */
export function validateSkillPackage(
  entryContent: string,
  bundledFiles: Record<string, string | Buffer> = {},
  manifest?: Partial<AgentSkillManifest>,
  limits: SkillValidationLimits = DEFAULT_SKILL_LIMITS,
): SkillValidationResult {
  const issues: ValidationIssue[] = [];

  // Entry file verification
  if (!entryContent || entryContent.trim().length === 0) {
    issues.push({
      field: "entry_file",
      message: "SKILL.md entry content is empty or missing",
      fatal: true,
    });
  }

  // File count limit
  const totalFiles = 1 + Object.keys(bundledFiles).length;
  if (totalFiles > limits.maxFiles) {
    issues.push({
      field: "files",
      message: `File count (${totalFiles}) exceeds maximum allowed limit (${limits.maxFiles})`,
      fatal: true,
    });
  }

  // Size limit calculation
  let totalBytes = Buffer.byteLength(entryContent, "utf8");
  if (totalBytes > limits.maxSingleFileBytes) {
    issues.push({
      field: "entry_file",
      message: `SKILL.md size (${totalBytes} bytes) exceeds single-file limit (${limits.maxSingleFileBytes})`,
      fatal: true,
    });
  }

  for (const [relPath, content] of Object.entries(bundledFiles)) {
    // Relative path safety
    if (!isSafeRelativePath(relPath)) {
      issues.push({
        field: `bundledFiles.${relPath}`,
        message: `Path traversal or invalid path detected: "${relPath}"`,
        fatal: true,
      });
      continue;
    }

    const fileBytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
    totalBytes += fileBytes;

    if (fileBytes > limits.maxSingleFileBytes) {
      issues.push({
        field: `bundledFiles.${relPath}`,
        message: `File ${relPath} size (${fileBytes} bytes) exceeds limit (${limits.maxSingleFileBytes})`,
        fatal: true,
      });
    }
  }

  if (totalBytes > limits.maxTotalBytes) {
    issues.push({
      field: "total_size",
      message: `Total package size (${totalBytes} bytes) exceeds limit (${limits.maxTotalBytes})`,
      fatal: true,
    });
  }

  // Manifest metadata validation if provided
  if (manifest) {
    if (manifest.apiVersion && manifest.apiVersion !== "pao.dev/v1") {
      issues.push({
        field: "apiVersion",
        message: `Unsupported apiVersion: ${manifest.apiVersion} (expected pao.dev/v1)`,
        fatal: false,
      });
    }
    if (manifest.metadata) {
      if (!manifest.metadata.name) {
        issues.push({ field: "metadata.name", message: "Metadata name is required", fatal: true });
      }
      if (!manifest.metadata.slug) {
        issues.push({ field: "metadata.slug", message: "Metadata slug is required", fatal: true });
      }
      if (!manifest.metadata.version) {
        issues.push({ field: "metadata.version", message: "Metadata version is required", fatal: true });
      }
    }
  }

  const fatalCount = issues.filter(i => i.fatal).length;
  return {
    valid: fatalCount === 0,
    issues,
  };
}

