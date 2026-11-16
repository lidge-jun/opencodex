import { helperPath, repoRoot } from "./repo-root";

/** Line the fixture prints once its modules are loaded and its setup is done. */
export const CONTINUATION_READY = "continuation-fixture-ready";
/** Process start and module loading: generous, because a loaded Windows runner can take seconds. */
export const CONTINUATION_STARTUP_MS = 30_000;
/** The bound the continuation tests actually assert: the stream must resume and end this soon. */
export const CONTINUATION_STREAM_MS = 2_500;

export interface ContinuationFixtureRun { exit: number; stdout: string; stderr: string; timedOut?: "startup" | "stream" }

/**
 * Spawn tests/helpers/messages-sse-continuation-run.ts and time only the stream.
 *
 * The stream deadline starts when the fixture reports ready, so spawning a Bun process and
 * importing the server modules never count against it. Before this split, a Windows lane=all
 * shard failed the 2.5 s deadline (run 43680563343) on code no change had touched.
 */
export async function runContinuationFixture(args: string[], env: Record<string, string>): Promise<ContinuationFixtureRun> {
  const child = Bun.spawn([process.execPath, helperPath("messages-sse-continuation-run.ts"), ...args], {
    cwd: repoRoot(), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  let timedOut: ContinuationFixtureRun["timedOut"];
  let timer = setTimeout(() => { timedOut = "startup"; child.kill(); }, CONTINUATION_STARTUP_MS);
  let stdout = "";
  const readStdout = (async () => {
    const decoder = new TextDecoder();
    let armed = false;
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
      if (!armed && stdout.includes(CONTINUATION_READY)) {
        armed = true;
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = "stream"; child.kill(); }, CONTINUATION_STREAM_MS);
      }
    }
  })();
  try {
    const [exit, , stderr] = await Promise.all([child.exited, readStdout, new Response(child.stderr).text()]);
    return { exit, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
