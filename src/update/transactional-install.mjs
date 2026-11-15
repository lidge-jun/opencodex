import { guardedRenameSync, ownedArtifactRm } from "./mutation-guard.mjs";
/**
 * Transactional npm self-update: stage -> verify -> swap -> rollback (#1942 / #1849).
 *
 * The legacy path ran `npm install -g` straight into the live global tree, so a
 * failure after npm removed the old files left a file-less package skeleton with no
 * recovery. This module stages the new version into a SIBLING directory of the live
 * package (same volume, so directory renames are atomic-ish and never cross devices),
 * verifies the staged tree with a manifest before anything live is touched, then swaps
 * live -> backup -> stage-into-live with a reverse-rename rollback on failure and a
 * recovery marker on double fault.
 *
 * Layout (siblings, never children — a child would travel WITH the live rename and the
 * live dir cannot move into its own subtree):
 *   <scopeDir>/opencodex                      live package
 *   <scopeDir>/.ocx-staging-<ts>/             npm --prefix root (contains node_modules/...)
 *   <scopeDir>/.ocx-backup-<ts>/opencodex     previous live tree during/after the swap
 *   <scopeDir>/.ocx-recovery.json             double-fault marker with a one-line restore
 *
 * A staging directory is created exclusively and immediately carries an ownership marker
 * (`.ocx-update-owner.json`). Later updates report leftovers but do not delete them: a marker
 * proves provenance only while this process owns the fresh path, not after another local
 * process could have replaced it. Other neighbouring entries are likewise left alone (#5624).
 */
import { probeSpawnSync } from "./mutation-guard.mjs";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isInMarkedPnpmCustomStore } from "./pnpm-store-layout.mjs";

/**
 * Dependency lookup confined to the candidate's OWN tree. This is the npm contract and it
 * must stay lexical: Node's resolver walks the ancestor directory chain, so a global npm
 * candidate at <prefix>/lib/node_modules/@scope/pkg could satisfy its bundled-Bun
 * requirement from <prefix>/lib/node_modules/bun, which belongs to a different package.
 * That verdict is not cosmetic — it accepts a stage that cannot start (D2), skips the
 * post-swap rollback, and lets bootRestoreProbe reap the only known-good backup.
 */
function candidateTreeDependencyDir(packageDir, name) {
  const dir = join(packageDir, "node_modules", ...name.split("/"));
  return existsSync(join(dir, "package.json")) ? dir : undefined;
}

/**
 * The candidate's own bun directory, whether or not it carries a readable package.json.
 * The size gate keys on the DIRECTORY, matching the pre-carry verifier: a half-extracted
 * node_modules/bun holding a truncated binary and no manifest is still a broken tree, and
 * bun is not always among the sentinels, so the sentinel loop cannot be relied on to catch it.
 */
function ownTreeBunDir(packageDir) {
  const dir = join(packageDir, "node_modules", "bun");
  return existsSync(dir) ? dir : undefined;
}

/** The node_modules directory a package sits directly inside, or undefined. */
function enclosingNodeModules(packageDir) {
  const parent = dirname(packageDir);
  if (basename(parent) === "node_modules") return parent;
  // Scoped packages live one level deeper: <node_modules>/@scope/name.
  const grandparent = dirname(parent);
  if (basename(parent).startsWith("@") && basename(grandparent) === "node_modules") return grandparent;
  return undefined;
}

/** pnpm's own bookkeeping at the root of a node_modules tree it manages. */
function isPnpmManagedRoot(nodeModulesDir) {
  if (!nodeModulesDir) return false;
  if (nodeModulesDir.split(/[\\/]/).includes(".pnpm")) return true;
  return existsSync(join(nodeModulesDir, ".pnpm")) || existsSync(join(nodeModulesDir, ".modules.yaml"));
}

/**
 * Containment is checked on canonical paths, with a separator boundary rather than a
 * string prefix so a sibling with a similar name cannot count as part of the store.
 */
function inside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Follow one link's own text component by component, as the operating system does. Collapsing ".."
 * first would hide a relay such as `../outside/relay/../../store/...`. A step down must land inside
 * an allowed root or on an ancestor of one (pnpm's relative links climb through those ancestors); a
 * step through another link before the last component is refused, because ".." after it would be
 * resolved from that link's target rather than from the spelling checked here.
 */
function followLinkText(linkPath, text, spellings) {
  const raw = String(text);
  const root = isAbsolute(raw) ? parse(raw).root : "";
  const parts = raw.slice(root.length).split(sep === "\\" ? /[\\/]+/ : /\/+/).filter(part => part && part !== ".");
  let current = root ? resolve(root) : dirname(linkPath);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === "..") { current = dirname(current); continue; }
    current = join(current, parts[index]);
    if (!spellings.some(root => inside(current, root) || inside(root, current))) throw new Error("link is outside the selected store");
    if (index < parts.length - 1) {
      let stat;
      try { stat = lstatSync(current); } catch { throw new Error("link is outside the selected store"); }
      if (stat.isSymbolicLink()) throw new Error("link is outside the selected store");
    }
  }
  return current;
}

/** Resolve every link after entering a store; an external hop cannot vouch for a later return. */
function resolveStoreLinkChain(path, store, alias, alternateRoot, alternateAlias) {
  const roots = alternateRoot ? [store, alternateRoot] : [store];
  const spellings = [store, alias, alternateRoot, alternateAlias].filter(Boolean);
  const normalize = value => {
    const target = resolve(value);
    if (alias && inside(target, alias)) return resolve(store, relative(alias, target));
    if (alternateAlias && inside(target, alternateAlias)) return resolve(alternateRoot, relative(alternateAlias, target));
    return target;
  };
  let pending = normalize(path), hops = 0;
  for (;;) {
    const root = roots.find(candidate => inside(pending, candidate));
    if (!root) throw new Error("link is outside the selected store");
    const parts = relative(root, pending).split(sep).filter(Boolean);
    let prefix = root, changed = false;
    for (let index = 0; index < parts.length; index += 1) {
      prefix = join(prefix, parts[index]);
      if (!lstatSync(prefix).isSymbolicLink()) continue;
      if (++hops > 64) throw new Error("too many store link hops");
      const target = normalize(followLinkText(prefix, readlinkSync(prefix), spellings));
      if (!roots.some(candidate => inside(target, candidate))) throw new Error("link is outside the selected store");
      pending = resolve(target, ...parts.slice(index + 1));
      changed = true;
      break;
    }
    if (!changed) return prefix;
  }
}

/** "none" without a v<N>/links component, "isolated" when a .pnpm store sits below the last one, else "links". */
function linksComponentState(path) {
  const parts = String(path).split(/[\\/]+/);
  let links = -1;
  for (let i = 1; i < parts.length; i += 1) {
    if (/^links$/i.test(parts[i]) && /^v\d+$/i.test(parts[i - 1])) links = i;
  }
  if (links < 0) return "none";
  for (let i = links + 1; i < parts.length - 1; i += 1) {
    if (/^node_modules$/i.test(parts[i]) && /^\.pnpm$/i.test(parts[i + 1])) return "isolated";
  }
  return "links";
}

/** The spelling up to and including its last v<N>/links component, or null without one. */
function linksRoot(path) {
  const parts = String(path).split(/[\\/]+/);
  let links = -1;
  for (let i = 1; i < parts.length; i += 1) {
    if (/^links$/i.test(parts[i]) && /^v\d+$/i.test(parts[i - 1])) links = i;
  }
  return links < 0 ? null : parts.slice(0, links + 1).join(sep) || sep;
}

/** Retain intermediate spellings: realpath alone hides a links directory behind another symlink. */
function packagePathUsesGlobalLinks(packageDir, store, storeAlias = store) {
  let path = resolve(packageDir);
  let found = false;
  // Spellings with a v<N>/links component. Each classifies unless the package finally lands in an isolated
  // install (a node_modules/.pnpm store) inside that same links directory: an isolated group's top-level link
  // into its own .pnpm store is not a global-store link, while a link that leaves for anywhere else is.
  const linkRoots = [];
  for (let hop = 0; hop < 64; hop += 1) {
    if (store && (inside(path, store) || (storeAlias && inside(path, storeAlias)))) {
      resolveStoreLinkChain(path, store, storeAlias);
    }
    // Every effective spelling, the listed one first, is judged. The isolated-install exception covers the
    // default store/v<N>/links spelling too: a global-store link instance never contains node_modules/.pnpm
    // below its links directory.
    const state = linksComponentState(path);
    if (state === "links") linkRoots.push(linksRoot(path));
    found ||= state === "none" && Boolean(store && inside(path, join(store, "links")));
    // Store markers classify on every effective spelling, not only the final realpath, so a listed path below a
    // marked store whose package link points elsewhere still demands the store proof.
    found ||= isInMarkedPnpmCustomStore(path.replaceAll("\\", "/"), existsSync);
    const root = parse(path).root;
    const parts = path.slice(root.length).split(sep).filter(Boolean);
    let prefix = root, changed = false;
    for (let i = 0; i < parts.length; i += 1) {
      prefix = join(prefix, parts[i]);
      if (lstatSync(prefix).isSymbolicLink()) {
        const target = resolve(dirname(prefix), readlinkSync(prefix));
        const remaining = parts.slice(i + 1);
        // Judge the effective spelling (target plus the rest of the path), so a package reached through a
        // group link classifies exactly as the same location reached directly.
        path = resolve(target, ...remaining);
        changed = true;
        break;
      }
    }
    // The joined spelling after a hop is judged at the top of the next iteration; the final location was
    // judged in this one (owner decision B: a package listed directly inside v<N>/links needs the proof).
    if (!changed) {
      const isolated = linksComponentState(path) === "isolated";
      return found || linkRoots.some(root => !(isolated && inside(path, root)));
    }
  }
  throw new Error("pnpm package symlink chain is too long");
}

/**
 * True unless this root spelling is canonical: no "." or ".." segment (path.resolve would delete them
 * without visiting the links they cross), no link or junction component, and realpath returns the same
 * path (case folded; a case-only symlink is caught by the component walk).
 */
function spellingHasLinkComponent(path) {
  const raw = String(path);
  const { root } = parse(raw);
  const parts = raw.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (!root || parts.some(part => part === "." || part === "..")) return true;
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  const fold = value => resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return fold(realpathSync.native(raw)) !== fold(raw);
}

/**
 * Whether any spelling of this package passes through pnpm store links. This only classifies which
 * proof the updater must obtain; it never accepts a package. An unreadable chain throws.
 */
export function pnpmPackageUsesGlobalStoreLinks(packageDir) {
  if (packagePathUsesGlobalLinks(packageDir, undefined)) return true;
  // A configured virtual-store directory inside a custom store has no \`links\` component; pnpm's
  // store markers route it to the same store proof.
  return isInMarkedPnpmCustomStore(realpathSync(packageDir).replaceAll("\\", "/"), existsSync);
}

/**
 * Dependency roots this package INSTANCE owns. pnpm exposes dependencies in several shapes —
 * symlinks inside the package's own node_modules, a package root that is itself a symlink into
 * the virtual store, or a hoisted group root — so the npm rule alone rejects healthy trees.
 * Ownership is still bounded: an enclosing node_modules counts only when pnpm's own metadata
 * says pnpm manages it, or when the package's realpath group sits in pnpm's global virtual
 * store, which keeps an unrelated ancestor installation out.
 */
function ownedDependencyRoots(packageDir, store) {
  const roots = [];
  const add = dir => { if (dir && !roots.includes(dir)) roots.push(dir); };
  const lexicalGroup = enclosingNodeModules(packageDir);
  add(join(packageDir, "node_modules"));
  let real;
  try { real = realpathSync(packageDir); } catch { /* keep the lexical path only */ }
  if (real && real !== packageDir) add(join(real, "node_modules"));
  if (isPnpmManagedRoot(lexicalGroup)) add(lexicalGroup);
  const realGroup = real ? enclosingNodeModules(real) : undefined;
  if (isPnpmManagedRoot(realGroup) || (store && realGroup && inside(realGroup, store))) add(realGroup);
  return roots;
}

/**
 * pnpm dependency lookup. Probing the owned roots directly, rather than filtering whatever
 * Node's resolver returned, is deliberate: require.resolve reports the REALPATH of the
 * resolved file, so a dependency reached through pnpm's own node_modules symlink comes back
 * as a virtual-store path that no lexical ownership test can recognise. existsSync follows
 * the symlink, which is exactly the pnpm graph edge that proves ownership.
 */
function pnpmOwnedDependencyDir(packageDir, name, store, globalLinks, escaped, roots = ownedDependencyRoots(packageDir, store), storeAlias = store) {
  let matched;
  for (const root of roots) {
    const dir = join(root, ...name.split("/"));
    if (globalLinks) {
      if (name.startsWith("@") && name.includes("/")) {
        const scope = join(root, name.split("/")[0]);
        let scopeStat;
        try { scopeStat = lstatSync(scope); } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm dependency link could not be resolved: " + name);
          continue;
        }
        if (scopeStat.isSymbolicLink()) {
          try { if (!inside(realpathSync(scope), store)) { escaped.add("pnpm dependency link escapes the selected store: " + name); continue; } }
          catch { escaped.add("pnpm dependency link could not be resolved: " + name); continue; }
        }
      }
      try { lstatSync(dir); } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm dependency link could not be resolved: " + name);
        continue;
      }
      try {
        const realRoot = realpathSync(root);
        if (!inside(realRoot, store)) { escaped.add("pnpm dependency root is outside the selected store: " + name); continue; }
        if (!inside(realpathSync(dir), store)) { escaped.add("pnpm dependency link escapes the selected store: " + name); continue; }
        if (!inside(resolveStoreLinkChain(join(realRoot, ...name.split("/")), store, storeAlias), store)) { escaped.add("pnpm dependency link escapes the selected store: " + name); continue; }
      } catch (error) {
        escaped.add(error?.message === "link is outside the selected store"
          ? "pnpm dependency link escapes the selected store: " + name : "pnpm dependency link could not be resolved: " + name);
        continue;
      }
    }
    if (globalLinks) {
      try {
        if (statSync(dir).isDirectory() && !existsSync(join(dir, "package.json"))) {
          escaped.add("pnpm dependency manifest could not be read: " + name); continue;
        }
      } catch { escaped.add("pnpm dependency link could not be resolved: " + name); continue; }
    }
    if (!matched && existsSync(join(dir, "package.json"))) matched = dir;
  }
  return matched;
}

/** A missing owned entry may still resolve through Node's ancestor lookup. */
function inspectAncestorDependency(packageDir, name, store, escaped) {
  for (let parent = dirname(packageDir); ; parent = dirname(parent)) {
    const candidate = join(parent, "node_modules", ...name.split("/"));
    for (const path of [candidate, candidate + ".js", candidate + ".json", candidate + ".node"]) {
      try { lstatSync(path); } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm dependency fallback could not be inspected: " + name);
        continue;
      }
      try {
        const resolved = realpathSync(path);
        escaped.add(inside(resolved, store) ? "pnpm dependency resolves outside its package group: " + name
          : "pnpm dependency can resolve outside the selected store: " + name);
      } catch { escaped.add("pnpm dependency fallback could not be resolved: " + name); }
      return;
    }
    if (parent === dirname(parent)) return;
  }
}

/**
 * Ancestor node_modules inside the store must keep their links in the store. Above the store the walk
 * stops: a user's ~/node_modules is not part of the package. A declared dependency that is missing in
 * the store and resolves from outside is refused separately (inspectAncestorDependency). With
 * preserved symlinks Node walks the lexical ancestors, so that walk keeps every root.
 */
function inspectAncestorRoots(packageDir, store, escaped, preserved = false, storeAlias = store, metadataSeen) {
  for (let parent = dirname(packageDir); ; parent = dirname(parent)) {
    if (!preserved && !inside(parent, store)) return;
    if (basename(parent) !== "node_modules") {
      const root = join(parent, "node_modules");
      let exists = true;
      try { lstatSync(root); } catch (error) {
        exists = false;
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm ancestor dependency root could not be resolved");
      }
      if (exists) {
        try {
          if (!inside(realpathSync(root), store)) escaped.add(preserved
            ? "pnpm preserved-symlink lookup root is outside the selected store" : "pnpm ancestor dependency root is outside the selected store");
          else {
            resolveStoreLinkChain(root, store, storeAlias);
            inspectPnpmMetadata(root, store, escaped, "ancestor dependency lookup", storeAlias, metadataSeen);
          }
        }
        catch { escaped.add("pnpm ancestor dependency root could not be resolved"); }
      }
    }
    if (parent === dirname(parent)) return;
  }
}

/** Resolve existing ancestors too, so a missing entry cannot hide an escaping symlink. */
function canonicalProspectivePath(path) {
  const missing = [];
  for (let current = path; ; current = dirname(current)) {
    try { return resolve(realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if ((error?.code !== "ENOENT" && error?.code !== "ENOTDIR") || current === dirname(current)) throw error;
      missing.push(basename(current));
    }
  }
}

function inspectPackageEntries(packageDir, manifest, store, escaped, alternateRoot) {
  const values = [manifest.main, manifest.module, manifest.bin, manifest.exports];
  const pending = [...values];
  while (pending.length) {
    const entry = pending.pop();
    if (entry && typeof entry === "object") { pending.push(...Object.values(entry)); continue; }
    if (typeof entry !== "string" || !entry) continue;
    try {
      const target = canonicalProspectivePath(resolve(packageDir, entry));
      if (!inside(target, store) && (!alternateRoot || !inside(target, alternateRoot))) {
        escaped.add("pnpm package entry point is outside the selected store");
      }
    } catch { escaped.add("pnpm package entry point could not be resolved"); }
  }
}

/** pnpm's metadata and executable directories are not packages, but their links still must stay inside the store. */
function inspectPnpmMetadata(path, store, escaped, kind, storeAlias = store, seen = new Set()) {
  const pending = [path];
  while (pending.length) {
    const current = pending.pop();
    let real;
    try {
      if (inside(current, store) && (current === path || lstatSync(current).isSymbolicLink())) {
        resolveStoreLinkChain(current, store, storeAlias);
      }
      real = realpathSync(current);
    }
    catch (error) {
      escaped.add("pnpm " + kind + (error?.message === "link is outside the selected store"
        ? " link escapes the selected store: " : " link could not be resolved: ") + basename(current));
      continue;
    }
    if (!inside(real, store)) { escaped.add("pnpm " + kind + " link escapes the selected store: " + basename(current)); continue; }
    if (seen.has(real)) continue;
    if (seen.size >= 10000) { escaped.add("pnpm metadata graph exceeds verification limit"); return; }
    seen.add(real);
    try {
      if (statSync(real).isDirectory()) for (const entry of readdirSync(real, { withFileTypes: true })) {
        if (!entry.isFile()) pending.push(join(real, entry.name));
      }
    }
    catch { escaped.add("pnpm " + kind + " link could not be resolved: " + basename(current)); }
  }
}

/**
 * Node's built-in global lookup paths, computed the way Node's module loader builds Module.globalPaths
 * (before NODE_PATH): $HOME/.node_modules and $HOME/.node_libraries (USERPROFILE on Windows), then
 * <prefix>/lib/node, where prefix is the executable's directory on Windows and its parent elsewhere.
 */
function nodeGlobalLookupPaths() {
  const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  const prefix = process.platform === "win32" ? resolve(process.execPath, "..") : resolve(process.execPath, "..", "..");
  return [...(home ? [resolve(home, ".node_modules"), resolve(home, ".node_libraries")] : []), resolve(prefix, "lib", "node")];
}

/**
 * Node's global search paths (Module.globalPaths, NODE_PATH) that lie inside the store must keep their
 * links there. Paths outside the store are the user's environment, not the package: they are not
 * evidence that the package left its store, and a missing declared dependency they could supply is
 * refused by inspectAncestorDependency's missing-dependency rule.
 */
function inspectGlobalLookupRoots(store, escaped, storeAlias = store) {
  const lookupRoots = new Set([...nodeGlobalLookupPaths(), ...String(process.env.NODE_PATH ?? "").split(delimiter).filter(Boolean)]);
  for (const raw of lookupRoots) {
    const root = resolve(raw);
    try { lstatSync(root); } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm global dependency lookup root could not be resolved");
      continue;
    }
    try {
      let real;
      // A dangling entry supplies nothing, like a missing one.
      try { real = realpathSync(root); } catch (error) { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue; throw error; }
      // Only a root whose own spelling lies in the store is part of it; an outside link into the store is
      // the user's environment, like any other outside entry. An in-store spelling must stay in the store.
      if (!(inside(root, store) || (storeAlias && inside(root, resolve(storeAlias))))) continue;
      if (!inside(real, store)) { escaped.add("pnpm global dependency lookup root is outside the selected store"); continue; }
      resolveStoreLinkChain(root, store, storeAlias);
    } catch { escaped.add("pnpm global dependency lookup root could not be resolved"); continue; }
    inspectPnpmMetadata(root, store, escaped, "global dependency lookup", storeAlias);
  }
}

/** Find nested module roots and validate package links without following them outside the store. */
function nestedPnpmRoots(packageDir, store, escaped, budget, storeAlias = store) {
  const pending = [packageDir], seen = new Set(), roots = [];
  while (pending.length) {
    const current = pending.pop();
    let real;
    try { real = realpathSync(current); } catch { escaped.add("pnpm package path could not be resolved"); continue; }
    if (!inside(real, store)) { escaped.add("pnpm package link escapes the selected store"); continue; }
    const manifestPath = join(current, "package.json");
    try {
      lstatSync(manifestPath);
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        inspectPackageEntries(current, manifest, store, escaped);
        if (current !== real) inspectPackageEntries(real, manifest, store, escaped);
      } catch { escaped.add("pnpm nested package manifest could not be read"); }
    } catch (error) {
      if (error?.code !== "ENOENT") escaped.add("pnpm nested package manifest could not be read");
    }
    if (seen.has(real)) continue;
    if (budget.remaining-- <= 0) { escaped.add("pnpm package traversal exceeds verification limit"); return roots; }
    seen.add(real);
    try {
      for (const entry of readdirSync(real, { withFileTypes: true })) {
        const child = join(current, entry.name);
        if (entry.name === "node_modules") {
          try { roots.push(resolveStoreLinkChain(child, store, storeAlias)); }
          catch { escaped.add("pnpm dependency root could not be resolved"); }
          continue;
        }
        // On Windows readdir reports junctions and directory symlinks as directories; lstat decides there.
        let isLink = entry.isSymbolicLink();
        if (!isLink && entry.isDirectory() && process.platform === "win32") {
          try { isLink = lstatSync(join(real, entry.name)).isSymbolicLink(); }
          catch { escaped.add("pnpm package link could not be resolved"); continue; }
        }
        if (!isLink && entry.isDirectory()) pending.push(child);
        else if (isLink) {
          try {
            const target = resolveStoreLinkChain(child, store, storeAlias);
            if (!inside(target, store)) escaped.add("pnpm package link escapes the selected store");
            else if (statSync(target).isDirectory()) pending.push(target);
          } catch (error) { escaped.add(error?.message === "link is outside the selected store"
            ? "pnpm package link escapes the selected store" : "pnpm package link could not be resolved"); }
        }
      }
    } catch { escaped.add("pnpm package directory could not be inspected"); }
  }
  return roots;
}

/** Check reachable global-store package roots and declared dependency links, including cycles. */
function inspectGlobalPnpmGraph(packageDir, store, escaped, storeAlias = store) {
  const pending = [packageDir], seen = new Set(), enumeratedRoots = new Set();
  const ancestorMetadataSeen = new Set(), metadataSeen = new Map(), budget = { remaining: 100000 };
  inspectGlobalLookupRoots(store, escaped, storeAlias);
  while (pending.length) {
    const spelling = pending.pop();
    let path;
    try { path = realpathSync(spelling); } catch { escaped.add("pnpm dependency package could not be resolved"); continue; }
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(spelling, "package.json"), "utf8")); }
    catch { escaped.add("pnpm dependency manifest could not be read"); continue; }
    inspectPackageEntries(spelling, manifest, store, escaped);
    if (path !== spelling) inspectPackageEntries(path, manifest, store, escaped);
    if (seen.has(path)) continue;
    if (seen.size >= 10000) { escaped.add("pnpm dependency graph exceeds verification limit"); return; }
    seen.add(path);
    inspectAncestorRoots(path, store, escaped, false, storeAlias, ancestorMetadataSeen);
    const names = new Set();
    const nestedRoots = nestedPnpmRoots(spelling, store, escaped, budget, storeAlias);
    const ownRoot = join(path, "node_modules"), groupRoot = enclosingNodeModules(path);
    const enqueueRootEntry = (root, name) => {
      const dependency = pnpmOwnedDependencyDir(path, name, store, true, escaped, [root], storeAlias);
      if (dependency) pending.push(dependency);
    };
    for (const root of [...new Set([ownRoot, groupRoot, ...nestedRoots])]) {
      if (!root) continue;
      try { lstatSync(root); } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm dependency root could not be resolved");
        continue;
      }
      try {
        const realRoot = realpathSync(root);
        if (!inside(realRoot, store)) { escaped.add("pnpm dependency root is outside the selected store"); continue; }
        if (inside(root, store) || (storeAlias && inside(root, storeAlias))) resolveStoreLinkChain(root, store, storeAlias);
        // Link hops for each spelling were checked above; expand the physical group once.
        if (enumeratedRoots.has(realRoot)) continue;
        enumeratedRoots.add(realRoot);
        for (const name of readdirSync(root)) {
          if ([".bin", ".pnpm", ".modules.yaml"].includes(name)) {
            const kind = name === ".bin" ? "binary" : "metadata";
            if (!metadataSeen.has(kind)) metadataSeen.set(kind, new Set());
            inspectPnpmMetadata(join(root, name), store, escaped, kind, storeAlias, metadataSeen.get(kind));
            continue;
          }
          if (!name.startsWith("@")) { enqueueRootEntry(root, name); continue; }
          const scope = join(root, name);
          try {
            if (!inside(realpathSync(scope), store)) { escaped.add("pnpm dependency scope is outside the selected store: " + name); continue; }
            if (statSync(scope).isDirectory()) for (const child of readdirSync(scope)) enqueueRootEntry(root, name + "/" + child);
          } catch { escaped.add("pnpm dependency scope could not be resolved: " + name); }
        }
      } catch { escaped.add("pnpm dependency root could not be resolved"); }
    }
    for (const name of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) names.add(name);
    for (const name of names) {
      const dependency = pnpmOwnedDependencyDir(path, name, store, true, escaped, undefined, storeAlias);
      if (dependency) pending.push(dependency);
      for (const root of nestedRoots) {
        if (root === ownRoot || root === groupRoot) continue;
        const nested = pnpmOwnedDependencyDir(path, name, store, true, escaped, [root], storeAlias);
        if (nested) pending.push(nested);
      }
      if (!dependency) {
        // pnpm can leave even non-optional peers absent when peer auto-install and strict checking are disabled.
        const required = Object.hasOwn(manifest.dependencies ?? {}, name) && !Object.hasOwn(manifest.optionalDependencies ?? {}, name);
        if (required) {
          escaped.add("pnpm required dependency is missing from the selected store: " + name);
        }
        if (Object.hasOwn(manifest.dependencies ?? {}, name) || Object.hasOwn(manifest.optionalDependencies ?? {}, name)
          || Object.hasOwn(manifest.peerDependencies ?? {}, name)) inspectAncestorDependency(path, name, store, escaped);
      }
    }
  }
}

/** Verification manifest for a staged (or live) package tree. */
function verifyTreeWithDependencyLookup(packageDir, expectedVersion, dependencyDir, inspectAllLinks = false) {
  const failures = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch (error) {
    return { ok: false, failures: ["package.json unreadable: " + (error?.message ?? String(error))] };
  }
  if (expectedVersion && pkg.version !== expectedVersion) {
    failures.push("package.json version " + pkg.version + " != expected " + expectedVersion);
  }
  const launcher = join(packageDir, "bin", "ocx.mjs");
  try {
    const st = statSync(launcher);
    if (!st.isFile() || st.size < 1024) failures.push("bin/ocx.mjs missing or truncated");
  } catch {
    failures.push("bin/ocx.mjs absent");
  }
  // The bundled Bun binary is the load-bearing artifact: without it the launcher exits
  // before serving anything, and a boot probe that called this tree healthy would reap
  // the only backup (review High 3). Size-gate the real binary, not just its package.json.
  const bunPkgDir = dependencyDir(packageDir, "bun") ?? ownTreeBunDir(packageDir);
  if (bunPkgDir) {
    const bunBinary = findLargestFile(bunPkgDir);
    if (!bunBinary || bunBinary.size < 10 * 1024 * 1024) {
      failures.push("bundled Bun binary missing or truncated (< 10MB)");
    }
  }
  // Sentinel direct deps: each must have an intact package.json. The bundled Bun dep is
  // the load-bearing one — without it the launcher cannot start the proxy at all.
  const deps = Object.keys(pkg.dependencies ?? {});
  if (inspectAllLinks) for (const name of new Set([...deps, ...Object.keys(pkg.optionalDependencies ?? {})])) dependencyDir(packageDir, name);
  const sentinels = deps.filter(name => name === "bun" || name === "zod").length > 0
    ? deps.filter(name => name === "bun" || name === "zod")
    : deps.slice(0, 2);
  for (const name of sentinels) {
    if (!dependencyDir(packageDir, name)) failures.push("sentinel dependency missing: " + name);
  }
  return failures.length === 0 ? { ok: true, failures: [] } : { ok: false, failures };
}

/**
 * npm (and every recovery decision): the candidate must be self-contained. Used by
 * transactionalNpmUpdate's stage and post-swap checks and by bootRestoreProbe.
 */
export function verifyInstallTree(packageDir, expectedVersion) {
  return verifyTreeWithDependencyLookup(packageDir, expectedVersion, candidateTreeDependencyDir);
}

/**
 * Verify a package exposed through pnpm's global virtual store. pnpm 10/11 may use an
 * isolated virtual store, a custom virtualStoreDir, global virtual-store links, or a
 * hoisted linker, so the dependency may sit outside the package directory — but it must
 * still be reachable through a root this package instance owns.
 */
export function verifyPnpmInstallTree(packageDir, expectedVersion, store, globalRoot, lexicalStore = store) {
  let real, canonicalGlobalRoot;
  try { real = realpathSync(packageDir); } catch { return { ok: false, failures: ["pnpm package path could not be resolved"] }; }
  try { if (store) store = realpathSync(store); } catch { return { ok: false, failures: ["pnpm configured store could not be resolved"] }; }
  if (globalRoot && (!store || !inside(real, store))) {
    try {
      canonicalGlobalRoot = realpathSync(globalRoot);
      if (!inside(real, canonicalGlobalRoot)) return { ok: false, failures: ["pnpm package is outside the selected store and global group"] };
    } catch { return { ok: false, failures: ["pnpm global group could not be resolved"] }; }
  }
  let globalLinks;
  try {
    globalLinks = packagePathUsesGlobalLinks(packageDir, store, lexicalStore) || (store && inside(real, store));
  } catch (error) { return { ok: false, failures: [error?.message === "link is outside the selected store"
    ? "pnpm global links are outside the selected store" : "pnpm package symlink chain could not be resolved"] }; }
  if (globalLinks && (!store || !inside(real, store))) {
    return { ok: false, failures: ["pnpm global links are outside the selected store"] };
  }
  if (globalLinks) {
    // The reported package spelling is walked as written below; resolve() would delete "." and ".."
    // segments without visiting the links they cross, so such a spelling is refused first.
    if (String(packageDir).split(/[\\/]+/).some(part => part === "." || part === "..")) {
      return { ok: false, failures: ["pnpm package path is not canonical"] };
    }
    // Hop roots are only as narrow as their spelling: a link component in the lexical store or global
    // group would make its target, and any relay below it, count as inside.
    for (const root of [lexicalStore, globalRoot]) {
      // A missing group authorizes nothing (see below), so only an existing spelling is inspected.
      if (!root || !existsSync(root)) continue;
      try { if (spellingHasLinkComponent(root)) return { ok: false, failures: ["pnpm store or global group path is not canonical"] }; }
      catch { return { ok: false, failures: ["pnpm store or global group path could not be resolved"] }; }
    }
    // Every hop from the reported spelling to the package must stay inside the selected global group
    // or the selected store; a relay elsewhere cannot vouch for a link that later returns to the store.
    // A group that cannot be resolved authorizes nothing: the path must then start inside the store.
    let canonicalGroup;
    try { if (globalRoot) canonicalGroup = realpathSync(globalRoot); } catch { canonicalGroup = undefined; }
    try {
      const end = canonicalGroup
        ? resolveStoreLinkChain(resolve(packageDir), store, lexicalStore, canonicalGroup, resolve(globalRoot))
        : resolveStoreLinkChain(resolve(packageDir), store, lexicalStore);
      if (!inside(end, store)) throw new Error("link is outside the selected store");
    } catch (error) {
      return { ok: false, failures: [error?.message === "link is outside the selected store"
        ? "pnpm global links are outside the selected store" : "pnpm package symlink chain could not be resolved"] };
    }
  }
  const escaped = new Set();
  if (globalLinks && /(?:^|[\s"'])--preserve-symlinks(?:-main)?(?=$|[\s"'])/.test([...process.execArgv, process.env.NODE_OPTIONS ?? ""].join(" "))) {
    inspectAncestorRoots(resolve(packageDir), store, escaped, true, lexicalStore);
  }
  const result = verifyTreeWithDependencyLookup(packageDir, expectedVersion,
    (path, name) => pnpmOwnedDependencyDir(path, name, store, globalLinks, escaped, undefined, lexicalStore), globalLinks);
  if (globalLinks) inspectGlobalPnpmGraph(real, store, escaped, lexicalStore);
  if (escaped.size) return { ok: false, failures: [...escaped].concat(result.failures) };
  return result;
}

function stampedName(prefix) {
  return prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-");
}

export const UPDATE_OWNER_MARKER = ".ocx-update-owner.json";
const STAGE_PREFIX = ".ocx-staging-";
/**
 * A marked stage younger than this is reported as recent. npm's staging install is bounded at
 * three minutes by the launcher; the floor distinguishes likely in-flight work from leftovers.
 */
export const STALE_STAGE_MIN_AGE_MS = 30 * 60 * 1000;
const RETRYABLE_REMOVE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/** Create a fresh staging directory that did not exist before, and mark it as ours. */
function createOwnedStage(scopeDir, pkgName, deps = {}) {
  const mkdir = deps.mkdir ?? mkdirSync;
  const stageRoot = join(scopeDir, stampedName(".ocx-staging") + "-" + randomBytes(4).toString("hex"));
  // Not recursive: an existing directory of the same name must fail, never be reused.
  mkdir(stageRoot);
  try {
    writeFileSync(join(stageRoot, UPDATE_OWNER_MARKER), JSON.stringify({
      schema: 1,
      kind: "staging",
      pkgName,
      pid: process.pid,
      createdAt: (deps.now ?? Date.now)(),
    }), { flag: "wx" });
    // npm's strict script policy plans the global tree before it creates the prefix layout, so
    // `-g --prefix` into a bare stage fails with ENOENT on <stage>/lib (#5760). POSIX global
    // prefixes keep packages under lib/; Windows installs into the prefix itself.
    if (process.platform !== "win32") mkdir(join(stageRoot, "lib"));
  } catch (error) {
    // Created by this call and not yet handed to npm: remove it rather than leave a partial stage.
    try { ownedArtifactRm(stageRoot, { recursive: true, force: true }); } catch { /* reported by the caller */ }
    throw error;
  }
  return stageRoot;
}

/** The marker of a real (non-link) staging directory this updater created, or null. */
function readOwnedStageMarker(dir, pkgName) {
  try {
    const dirStat = lstatSync(dir);
    // A symlink or junction is never ours to delete: removing through it reaches its target.
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const markerPath = join(dir, UPDATE_OWNER_MARKER);
    if (!lstatSync(markerPath).isFile()) return null;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker?.schema !== 1 || marker.kind !== "staging" || marker.pkgName !== pkgName) return null;
    if (typeof marker.createdAt !== "number" || !Number.isFinite(marker.createdAt)) return null;
    return marker;
  } catch {
    return null;
  }
}

function removeWithRetry(rm, target, attempts = 3) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      ownedArtifactRm(target, { recursive: true, force: true }, rm);
      return null;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "EUNKNOWN";
      if (!RETRYABLE_REMOVE_CODES.has(code) || attempt >= attempts - 1) return code;
      const until = Date.now() + 100 * (attempt + 1);
      while (Date.now() < until) { /* brief synchronous backoff, as renameWithRetry */ }
    }
  }
}

/**
 * Remove an owned staging directory. The marker goes last and only once everything else is
 * gone, so a tree held open by a running executable (the reported locked `bunx.exe`) stays
 * provably ours and the next update can finish the job.
 */
export function removeOwnedStage(stageRoot, deps = {}) {
  const rm = deps.rm;
  let names;
  try {
    names = readdirSync(stageRoot);
  } catch (error) {
    return error?.code === "ENOENT" ? { removed: true } : { removed: false, code: error?.code ?? "EUNKNOWN" };
  }
  let failure = null;
  for (const name of names) {
    if (name === UPDATE_OWNER_MARKER) continue;
    const code = removeWithRetry(rm, join(stageRoot, name));
    if (code && !failure) failure = code;
  }
  if (failure) return { removed: false, code: failure };
  const markerCode = removeWithRetry(rm, join(stageRoot, UPDATE_OWNER_MARKER));
  if (markerCode) return { removed: false, code: markerCode };
  const dirCode = removeWithRetry(rm, stageRoot);
  return dirCode ? { removed: false, code: dirCode } : { removed: true };
}

/**
 * Report what earlier update attempts left next to the package. A marker is forgeable and a
 * pathname can be replaced after inspection, so no later process may recursively delete a
 * leftover by that pathname. Never throws or fails the update: fresh unique stages step around it.
 */
export function sweepUpdateLeftovers({ packageDir, pkgName, log = () => {}, deps = {} }) {
  const scopeDir = dirname(packageDir);
  const now = (deps.now ?? Date.now)();
  const result = { inUse: [], recent: [], notOwned: [] };
  let names = [];
  try {
    names = readdirSync(scopeDir);
  } catch {
    return result;
  }
  // npm renames a package it is replacing to ".<name>-<random>" during a direct global install.
  const renameAsidePrefix = "." + basename(packageDir) + "-";
  for (const name of names.sort()) {
    const full = join(scopeDir, name);
    if (name.startsWith(STAGE_PREFIX)) {
      const marker = readOwnedStageMarker(full, pkgName);
      if (!marker) {
        result.notOwned.push(full);
      } else if (now - marker.createdAt < STALE_STAGE_MIN_AGE_MS) {
        result.recent.push(full);
      } else {
        result.inUse.push({ path: full, code: "ESTALE" });
      }
    } else if (name.startsWith(renameAsidePrefix)) {
      result.notOwned.push(full);
    }
  }
  // Names only: the full path under a user-scoped npm prefix carries the account name, and
  // this logger is the launcher's console.
  for (const entry of result.inUse) {
    log(entry.code === "ESTALE"
      ? "Left an earlier update's staging directory in place; delete it by hand once no OpenCodex process is running from it: " + basename(entry.path)
      : "Left an earlier update's staging directory in place (could not remove it: " + entry.code + "): " + basename(entry.path));
  }
  for (const path of result.notOwned) {
    log("Not removing " + basename(path) + " next to the package: this updater did not create it. Delete it by hand once no OpenCodex process is running from it.");
  }
  return result;
}

/** Whether the launcher that ran this npm update can still drive service/tray recovery. */
export function launcherUsableAfterNpmUpdate(tx) {
  return Boolean(tx?.ok || tx?.rolledBack === true || ["stage", "verify", "authorize", "swap-backup"].includes(tx?.phase));
}

/** Largest regular file under a directory tree (bounded depth) — locates the Bun binary. */
function findLargestFile(root, depth = 3) {
  let best;
  let names = [];
  try { names = readdirSync(root); } catch { return undefined; }
  for (const name of names) {
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isFile()) {
      if (!best || st.size > best.size) best = { path: full, size: st.size };
    } else if (st.isDirectory() && depth > 0) {
      const sub = findLargestFile(full, depth - 1);
      if (sub && (!best || sub.size > best.size)) best = sub;
    }
  }
  return best;
}

/** Bounded Windows-class rename retry: EPERM/EBUSY/EACCES from AV/indexers clears in ms. */
function renameWithRetry(rename, from, to, authorize = () => true, attempts = 5) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      guardedRenameSync(authorize, from, to, rename);
      return;
    } catch (error) {
      const code = error?.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= attempts - 1) throw error;
      // Synchronous bounded backoff (launcher context has no async loop here).
      const until = Date.now() + 100 * (attempt + 1);
      while (Date.now() < until) { /* spin briefly; total worst case ~1.5s */ }
    }
  }
}

function recoveryMarkerPath(scopeDir) {
  return join(scopeDir, ".ocx-recovery.json");
}

/** Startup probe: restore a backup when the live tree is broken (D4 power-loss rows). */
export function bootRestoreProbe(packageDir, deps = {}) {
  const rename = deps.rename;
  const scopeDir = dirname(packageDir);
  let backups = [];
  try {
    backups = readdirSync(scopeDir).filter(name => name.startsWith(".ocx-backup-")).sort();
  } catch {
    return { action: "none" };
  }
  if (backups.length === 0) return { action: "none" };
  const liveOk = existsSync(join(packageDir, "package.json"))
    && verifyInstallTree(packageDir).ok;
  const newestBackup = join(scopeDir, backups[backups.length - 1], "opencodex");
  if (liveOk) {
    // Live is healthy: the backups are leftovers from a completed swap. Reap them.
    for (const name of backups) {
      try { ownedArtifactRm(join(scopeDir, name), { recursive: true, force: true }); } catch { /* keep */ }
    }
    try { ownedArtifactRm(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* keep */ }
    return { action: "reaped", count: backups.length };
  }
  if (!existsSync(join(newestBackup, "package.json"))) return { action: "none" };
  try {
    try { ownedArtifactRm(packageDir, { recursive: true, force: true }); } catch { /* may not exist */ }
    guardedRenameSync(() => true, newestBackup, packageDir, rename);
    return { action: "restored", from: newestBackup };
  } catch (error) {
    return { action: "failed", error: error?.message ?? String(error) };
  }
}

/**
 * Run the transactional update. `runNpm(args, opts)` is injected so the caller keeps
 * its hardened npm resolution (npm-invocation.mjs) and logging.
 */
function* npmUpdateTransaction({
  packageDir,
  pkgName,
  targetVersion,
  tag,
  cachePath,
  mayReplacePackage = () => true,
  log = () => {},
  deps = {},
}) {
  const rename = deps.rename;
  const scopeDir = dirname(packageDir);
  // Leftovers from earlier attempts are only reported; fresh unique stages step around them. This never fails.
  try { sweepUpdateLeftovers({ packageDir, pkgName, log, deps }); } catch { /* report-only */ }
  let stageRoot;
  // GLOBAL-style staging (-g --prefix): npm nests the package's dependencies INSIDE the
  // package dir, exactly like the live global tree this stage will replace. A local-style
  // install would hoist bun/zod to stageRoot/node_modules — siblings that the swap would
  // leave behind, shipping a dependency-less live tree (release-audit blocker).
  // Layout: <stageRoot>/lib/node_modules/<pkg> on POSIX, <stageRoot>/node_modules/<pkg>
  // on Windows.

  // D1: stage to the side. --prefix keeps npm entirely inside stageRoot; the live tree
  // and the npm bin shims are untouched until the swap. A failure HERE (mkdir EACCES,
  // ENOSPC) must NOT fall back to the destructive legacy install (review High 4): the
  // caller sees a normal phase failure with live untouched.
  try {
    stageRoot = createOwnedStage(scopeDir, pkgName, deps);
  } catch (error) {
    return { ok: false, phase: "stage", error: "could not create staging directory: " + (error?.message ?? String(error)) };
  }
  const stagedCandidatesIn = root => [
    join(root, "lib", "node_modules", ...pkgName.split("/")),
    join(root, "node_modules", ...pkgName.split("/")),
  ];
  const discardStage = () => {
    const removal = removeOwnedStage(stageRoot, deps);
    if (!removal.removed) {
      // EACCES/EUNKNOWN do not prove an open file, so the message names the failure
      // without blaming a process; the code stays for whoever reads the log.
      log("Left this update's staging directory in place (could not remove it: " + removal.code + "); later updates will not remove it either — delete it by hand once no OpenCodex process is running from it: " + basename(stageRoot));
    }
  };
  const spec = pkgName + "@" + (targetVersion || tag);
  log("Staging " + spec + " into " + basename(stageRoot) + " next to the package");
  // npm 12 blocks lifecycle scripts by default. Bun's postinstall copies the selected
  // @oven/bun-* executable into bun/bin, so a successful npm exit without this narrow
  // approval leaves the staged tree intentionally incomplete. Allow only the package
  // whose executable the manifest verifies below; never broaden this to all scripts.
  // --prefix <stage> also moves npm's globalconfig to <stage>/etc/npmrc, so a `cache=` from the
  // operator's global npmrc would be dropped and npm would fall back to its default root. Pin
  // the cache the pre-flight resolved and checked, so staging uses that exact root (#6288).
  const cacheArgs = typeof cachePath === "string" && cachePath.length > 0 ? ["--cache", cachePath] : [];
  const install = yield [
    "install", "-g", "--prefix", stageRoot, ...cacheArgs,
    "--allow-scripts=bun", "--no-audit", "--no-fund", spec,
  ];
  if (install.status !== 0 || install.error || install.processTreeExited === false) {
    if (install.processTreeExited === false) {
      log("Left this update's staging directory in place: process-tree exit was not confirmed; stop the installer before removing " + basename(stageRoot));
    } else discardStage();
    const detail = install.error
      ? [install.error.code, install.error.message].filter(Boolean).join(": ")
      : install.signal ?? install.status ?? "?";
    return { ok: false, phase: "stage", ...(install.processTreeExited === false ? { processTreeExited: false } : {}), error: "npm staging install failed (" + detail + ")" };
  }
  const stagedPackage = stagedCandidatesIn(stageRoot).find(dir => existsSync(join(dir, "package.json")));
  if (!stagedPackage) {
    discardStage();
    return { ok: false, phase: "verify", error: "staged package directory not found under " + stageRoot };
  }

  // D2: verify INSIDE the stage. Live is still untouched on any failure here.
  const staged = verifyInstallTree(stagedPackage, targetVersion || undefined);
  if (!staged.ok) {
    discardStage();
    return { ok: false, phase: "verify", error: "staged tree failed verification: " + staged.failures.join("; ") };
  }

  // The installer may have awaited a supervisor. Only a synchronous true authorizes
  // the live swap; errors, promises and refusals leave live untouched.
  let authorized = false;
  try { authorized = mayReplacePackage() === true; } catch { /* fail closed */ }
  if (!authorized) {
    discardStage();
    return { ok: false, phase: "authorize", error: "package replacement authority changed; rerun from the beginning" };
  }
  // D3: swap. live -> backup, stage -> live, re-verify live, rollback on failure.
  const backupRoot = join(scopeDir, stampedName(".ocx-backup"));
  const backupPackage = join(backupRoot, "opencodex");
  try {
    mkdirSync(backupRoot, { recursive: true });
  } catch (error) {
    discardStage();
    return { ok: false, phase: "swap-backup", error: "could not create backup directory: " + (error?.message ?? String(error)) };
  }
  try {
    renameWithRetry(rename, packageDir, backupPackage, () => mayReplacePackage() === true);
  } catch (error) {
    discardStage();
    try { ownedArtifactRm(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: error?.code === "EUPDATEAUTHORITY" ? "authorize" : "swap-backup", error: "could not move live tree aside: " + (error?.message ?? String(error)) };
  }
  try {
    renameWithRetry(rename, stagedPackage, packageDir);
  } catch (error) {
    // Rollback: reverse the first rename. Double fault leaves the recovery marker.
    try {
      renameWithRetry(rename, backupPackage, packageDir);
      discardStage();
      try { ownedArtifactRm(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, phase: "swap-live", rolledBack: true, error: "could not place staged tree: " + (error?.message ?? String(error)) };
    } catch (rollbackError) {
      writeFileSync(recoveryMarkerPath(scopeDir), JSON.stringify({
        at: new Date().toISOString(),
        backup: backupPackage,
        live: packageDir,
        restore: 'move "' + backupPackage + '" back to "' + packageDir + '"',
        error: String(error?.message ?? error),
        rollbackError: String(rollbackError?.message ?? rollbackError),
      }, null, 2));
      return { ok: false, phase: "double-fault", rolledBack: false, error: "swap and rollback both failed; recovery marker written at " + recoveryMarkerPath(scopeDir) };
    }
  }
  const liveCheck = verifyInstallTree(packageDir, targetVersion || undefined);
  if (!liveCheck.ok) {
    try {
      // Move the rejected tree into our own stage instead of deleting it in place: a file held
      // open there must not turn a clean rollback into a double fault. The stage's marker keeps
      // it sweepable by the next update.
      renameWithRetry(rename, packageDir, join(stageRoot, "rejected"));
      renameWithRetry(rename, backupPackage, packageDir);
      discardStage();
      try { ownedArtifactRm(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, phase: "post-verify", rolledBack: true, error: "live tree failed post-swap verification: " + liveCheck.failures.join("; ") };
    } catch (rollbackError) {
      writeFileSync(recoveryMarkerPath(scopeDir), JSON.stringify({
        at: new Date().toISOString(),
        backup: backupPackage,
        live: packageDir,
        restore: 'move "' + backupPackage + '" back to "' + packageDir + '"',
        error: "post-swap verification failed: " + liveCheck.failures.join("; "),
        rollbackError: String(rollbackError?.message ?? rollbackError),
      }, null, 2));
      return { ok: false, phase: "double-fault", rolledBack: false, error: "post-verify rollback failed; recovery marker written" };
    }
  }
  // Success: stage scaffolding is disposable now; the backup stays until the next
  // healthy boot reaps it (bootRestoreProbe) — the process that spawned this update may
  // still hold the old cwd.
  discardStage();
  return { ok: true, phase: "done", backup: backupPackage };
}

/** Keep synchronous callers while the Node launcher awaits the install/exit barrier. */
export function transactionalNpmUpdate(options) {
  const transaction = npmUpdateTransaction(options);
  const step = transaction.next();
  if (step.done) return step.value;
  // Preserve the legacy status-only transaction on POSIX and for existing callers.
  const install = options.runNpm(step.value);
  return transaction.next({ status: install.status }).value;
}

export async function transactionalNpmUpdateAsync(options) {
  const transaction = npmUpdateTransaction(options);
  const step = transaction.next();
  if (step.done) return step.value;
  let install;
  try { install = await options.runNpm(step.value); }
  catch (error) { install = { status: null, error, processTreeExited: false }; }
  if (install.processTreeExited !== true && !(install.groupExited === true && typeof install.status === "number")) install = { ...install, status: null, processTreeExited: false,
    error: install.error ?? { code: "EINSTALLJOIN", message: "npm process-tree exit was not confirmed" } };
  return transaction.next(install).value;
}
