// Phase 15 — Atlas and Universe graph projections.
//
// Graphs are derived from canonical project/scan metadata. They are never a
// source of truth: deleting/rebuilding this projection cannot lose project
// files, sessions, or scan history.

import { openAgentOsDb } from "./db";

export type BrainNodeType = "universe" | "project" | "folder" | "file";

export interface BrainGraphNode {
  id: string;
  type: BrainNodeType;
  label: string;
  path?: string;
  projectId?: string;
  disposition?: string;
  sizeBytes?: number;
  extension?: string | null;
}

export interface BrainGraphEdge {
  source: string;
  target: string;
  type: "contains";
}

export interface ProjectAtlas {
  project: { id: string; name: string; rootPath: string };
  scan: { id: string; mode: string; createdMs: number };
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  stats: {
    fileCount: number;
    folderCount: number;
    totalBytes: number;
    extensions: Record<string, number>;
  };
}

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
}

interface ScanRow {
  id: string;
  mode: string;
  coverage_json: string;
  created_ms: number;
}

interface FileRow {
  path: string;
  disposition: string;
  size_bytes: number;
  extension: string | null;
}

function folderNodeId(projectId: string, path: string): string {
  return `folder:${projectId}:${path}`;
}

function fileNodeId(projectId: string, path: string): string {
  return `file:${projectId}:${path}`;
}

export function getProjectAtlas(projectId: string): ProjectAtlas | null {
  const db = openAgentOsDb();
  const project = db
    .query("SELECT id, name, root_path FROM brain_projects WHERE id = ?")
    .get(projectId) as ProjectRow | undefined;
  if (!project) return null;
  const scan = db
    .query("SELECT id, mode, coverage_json, created_ms FROM brain_scans WHERE project_id = ? ORDER BY created_ms DESC, rowid DESC LIMIT 1")
    .get(projectId) as ScanRow | undefined;
  if (!scan) return null;
  const files = db
    .query("SELECT path, disposition, size_bytes, extension FROM brain_files WHERE scan_id = ? ORDER BY path")
    .all(scan.id) as FileRow[];

  const projectNodeId = `project:${project.id}`;
  const nodes: BrainGraphNode[] = [{
    id: projectNodeId,
    type: "project",
    label: project.name,
    path: "",
    projectId: project.id,
  }];
  const edges: BrainGraphEdge[] = [];
  const folders = new Set<string>();
  const extensions: Record<string, number> = {};
  let totalBytes = 0;

  for (const file of files) {
    const pathParts = file.path.split("/");
    const label = pathParts.at(-1) ?? file.path;
    const segments = pathParts.slice(0, -1);
    let current = "";
    let parentNodeId = projectNodeId;
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const nodeId = folderNodeId(project.id, current);
      if (!folders.has(current)) {
        folders.add(current);
        nodes.push({
          id: nodeId,
          type: "folder",
          label: segment,
          path: current,
          projectId: project.id,
        });
        edges.push({ source: parentNodeId, target: nodeId, type: "contains" });
      }
      parentNodeId = nodeId;
    }

    const nodeId = fileNodeId(project.id, file.path);
    nodes.push({
      id: nodeId,
      type: "file",
      label,
      path: file.path,
      projectId: project.id,
      disposition: file.disposition,
      sizeBytes: file.size_bytes,
      extension: file.extension,
    });
    edges.push({ source: parentNodeId, target: nodeId, type: "contains" });
    totalBytes += file.size_bytes;
    const extension = file.extension ?? "(none)";
    extensions[extension] = (extensions[extension] ?? 0) + 1;
  }

  return {
    project: { id: project.id, name: project.name, rootPath: project.root_path },
    scan: { id: scan.id, mode: scan.mode, createdMs: scan.created_ms },
    nodes,
    edges,
    stats: {
      fileCount: files.length,
      folderCount: folders.size,
      totalBytes,
      extensions,
    },
  };
}

export interface BrainUniverse {
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  projects: {
    id: string;
    name: string;
    rootPath: string;
    latestScan: {
      scanId: string;
      mode: string;
      createdMs: number;
      filesScanned: number;
    } | null;
  }[];
}

export function getBrainUniverse(): BrainUniverse {
  const db = openAgentOsDb();
  const projects = db
    .query("SELECT id, name, root_path FROM brain_projects ORDER BY name, id")
    .all() as ProjectRow[];
  const universeNodeId = "universe:root";
  const nodes: BrainGraphNode[] = [{
    id: universeNodeId,
    type: "universe",
    label: "Pao Brain Universe",
  }];
  const edges: BrainGraphEdge[] = [];
  const summaries: BrainUniverse["projects"] = [];

  for (const project of projects) {
    const projectNodeId = `project:${project.id}`;
    nodes.push({
      id: projectNodeId,
      type: "project",
      label: project.name,
      projectId: project.id,
    });
    edges.push({ source: universeNodeId, target: projectNodeId, type: "contains" });
    const scan = db
      .query("SELECT id, mode, coverage_json, created_ms FROM brain_scans WHERE project_id = ? ORDER BY created_ms DESC, rowid DESC LIMIT 1")
      .get(project.id) as ScanRow | undefined;
    const coverage = scan
      ? JSON.parse(scan.coverage_json) as { filesScanned?: number }
      : null;
    summaries.push({
      id: project.id,
      name: project.name,
      rootPath: project.root_path,
      latestScan: scan
        ? {
            scanId: scan.id,
            mode: scan.mode,
            createdMs: scan.created_ms,
            filesScanned: coverage?.filesScanned ?? 0,
          }
        : null,
    });
  }

  return { nodes, edges, projects: summaries };
}
