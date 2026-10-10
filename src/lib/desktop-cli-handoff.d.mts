import type { spawn } from "node:child_process";
import type { accessSync, lstatSync, statSync } from "node:fs";
import type { DesktopCliRecordRead, DesktopCliRecordIssue } from "./desktop-cli-record.mjs";
export type DesktopHandoffIssue = DesktopCliRecordIssue | "target-invalid" | "target-self" | "target-unusable" | "spawn-failed";
export type DesktopCliHandoffPlan =
  | { kind: "continue"; reason: "excluded" | "missing" | "disabled" | "target-missing" | "windows-path-only" }
  | { kind: "error"; issue: DesktopHandoffIssue }
  | { kind: "handoff"; target: string };
export type DesktopCliHandoffExit =
  | { kind: "continue" }
  | { kind: "error"; issue: "spawn-failed" }
  | { kind: "exit"; code: number; signal: NodeJS.Signals | null };
export function desktopHandoffExcluded(argv: string[], env?: NodeJS.ProcessEnv): boolean;
export function planDesktopCliHandoff(input?: {
  argv?: string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  recordRead?: DesktopCliRecordRead; selfPaths?: (string | undefined)[];
}, deps?: { stat?: typeof statSync; access?: typeof accessSync; realpath?: (path: string) => string }): DesktopCliHandoffPlan;
export function runDesktopCliHandoff(plan: Extract<DesktopCliHandoffPlan, { kind: "handoff" }>, launch: {
  argv: string[]; env: NodeJS.ProcessEnv; proof: string; context: string;
}, deps?: { spawn?: typeof spawn; lstat?: typeof lstatSync; parent?: Pick<NodeJS.Process, "on" | "removeListener">; platform?: NodeJS.Platform }): Promise<DesktopCliHandoffExit>;
