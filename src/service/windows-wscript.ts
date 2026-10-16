/**
 * The `wscript.exe` the Task Scheduler XML must name.
 *
 * Leaf module on purpose: `windows-taskxml.ts` needs it to render the task document,
 * and taking it from `windows-scheduler.ts` made the two one cyclic component.
 * `windows-scheduler` owns the schtasks process surface, not this one path lookup.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export function windowsWscript(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return existsSync(candidate) ? candidate : "wscript.exe";
}
