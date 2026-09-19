import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { isSafeRelativePath } from "./validator";
import type { ScopeType } from "./types";

export interface ScopeResolveOptions {
  agentType: string;
  scope: ScopeType;
  projectPath?: string;
  homeDir?: string;
  allowedRoots?: string[];
}

/**
 * Return true if `targetPath` is within or equal to `boundaryDir`.
 * Uses native path canonicalization and separator normalization.
 */
export function isPathWithinBoundary(targetPath: string, boundaryDir: string): boolean {
  const normTarget = resolve(targetPath);
  const normBoundary = resolve(boundaryDir);

  if (normTarget === normBoundary) return true;
  const prefix = normBoundary.endsWith(sep) ? normBoundary : normBoundary + sep;
  return normTarget.startsWith(prefix) && normTarget.length > normBoundary.length;
}

/**
 * Resolve the base skill directory for an agent according to scope.
 */
export function resolveAgentSkillRoot(
  agentType: string,
  scope: ScopeType,
  options: { projectPath?: string; homeDir?: string } = {},
): string {
  const home = options.homeDir ?? homedir();
  const project = options.projectPath ? resolve(options.projectPath) : process.cwd();

  switch (agentType.toLowerCase()) {
    case "codex":
      if (scope === "user") return join(home, ".codex", "skills");
      return join(project, ".codex", "skills");

    case "claude-code":
    case "claude":
      if (scope === "user") return join(home, ".claude", "skills");
      return join(project, ".claude", "skills");

    case "opencode":
      if (scope === "user") return join(home, ".config", "opencode", "skills");
      return join(project, ".opencode", "skills");

    case "cursor":
      if (scope === "user") return join(home, ".cursor", "skills");
      return join(project, ".cursor", "skills");

    case "universal":
    default:
      if (scope === "user") return join(home, ".agents", "skills");
      return join(project, ".agents", "skills");
  }
}

/**
 * Resolve and validate the target destination path for a skill.
 * Rejects path traversal and ensures the target stays strictly within the agent's approved root.
 */
export function resolveSkillTargetPath(
  skillSlug: string,
  options: ScopeResolveOptions,
): { targetPath: string; skillRoot: string; safe: boolean; error?: string } {
  // Check slug validity
  if (!skillSlug || !isSafeRelativePath(skillSlug) || skillSlug.includes("/")) {
    return {
      targetPath: "",
      skillRoot: "",
      safe: false,
      error: `Invalid skill slug: "${skillSlug}". Must be a single safe directory name.`,
    };
  }

  const skillRoot = resolve(resolveAgentSkillRoot(options.agentType, options.scope, options));
  const targetPath = resolve(join(skillRoot, skillSlug));

  // Canonicalize approved root if it exists
  let canonicalRoot = skillRoot;
  if (existsSync(skillRoot)) {
    try {
      canonicalRoot = realpathSync(skillRoot);
    } catch {
      canonicalRoot = skillRoot;
    }
  }

  // Ensure target path is strictly within the resolved skill root
  if (!isPathWithinBoundary(targetPath, canonicalRoot) && !isPathWithinBoundary(targetPath, skillRoot)) {
    return {
      targetPath: "",
      skillRoot,
      safe: false,
      error: `Resolved target path "${targetPath}" escapes the approved root "${skillRoot}".`,
    };
  }

  // Canonicalize deepest existing ancestor of targetPath to prevent symlink traversal
  let ancestor = dirname(targetPath);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    ancestor = dirname(ancestor);
  }
  if (existsSync(ancestor) && (ancestor === skillRoot || ancestor === canonicalRoot || isPathWithinBoundary(ancestor, canonicalRoot) || isPathWithinBoundary(ancestor, skillRoot))) {
    try {
      const realAncestor = realpathSync(ancestor);
      if (!isPathWithinBoundary(realAncestor, canonicalRoot) && realAncestor !== canonicalRoot && !isPathWithinBoundary(realAncestor, skillRoot)) {
        return {
          targetPath,
          skillRoot,
          safe: false,
          error: `Parent directory "${ancestor}" resolves outside approved boundary: "${realAncestor}".`,
        };
      }
    } catch (_realpathErr) {
      // Ignore inspection failure if ancestor cannot be resolved
    }
  }

  // If explicit allowed roots are provided (e.g. for remote nodes), verify target is within at least one
  if (options.allowedRoots && options.allowedRoots.length > 0) {
    const isAllowed = options.allowedRoots.some(root => isPathWithinBoundary(targetPath, resolve(root)));
    if (!isAllowed) {
      return {
        targetPath,
        skillRoot,
        safe: false,
        error: `Target path "${targetPath}" is outside allowed roots: [${options.allowedRoots.join(", ")}].`,
      };
    }
  }

  // Check for symlink escape if target already exists
  if (existsSync(targetPath)) {
    try {
      const lstat = lstatSync(targetPath);
      if (lstat.isSymbolicLink()) {
        const real = realpathSync(targetPath);
        if (!isPathWithinBoundary(real, skillRoot)) {
          return {
            targetPath,
            skillRoot,
            safe: false,
            error: `Target path is a symlink pointing outside approved boundary: "${real}".`,
          };
        }
      }
    } catch (e) {
      return {
        targetPath,
        skillRoot,
        safe: false,
        error: `Failed to inspect existing target path: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    targetPath,
    skillRoot,
    safe: true,
  };
}

