/** A header-stalling fixture with a test-owned release path. Release only after
 * cancellation assertions, and always from finally so server teardown can finish. */
export function heldResponse<Server>(
  serve: (handler: () => Promise<Response>) => Server,
): { server: Server; started: Promise<void>; release: () => void } {
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = serve(async () => {
    markStarted();
    await released;
    return new Response(null, { status: 204 });
  });
  return { server, started, release };
}
