import { lstatSync, mkdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { codexHomeIsAbsent } from "./codex-home-owner";

/** Return compensation for only the directory this request created, never its contents. */
export function prepareCodexHome(home: string, mode?: number): () => void {
  if (!codexHomeIsAbsent(home)) return () => {};
  mkdirSync(dirname(home), { recursive: true, mode });
  try { mkdirSync(home, { mode }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return () => {};
    throw error;
  }
  const created = lstatSync(home);
  return () => {
    try {
      const current = lstatSync(home);
      if (!created.isDirectory() || !created.ino || !current.isDirectory()
        || current.dev !== created.dev || current.ino !== created.ino) return;
      // rmdir itself checks emptiness; a concurrent file publication prevents removal.
      rmdirSync(home);
    } catch { /* Missing, populated or uncertain directories must be preserved. */ }
  };
}
