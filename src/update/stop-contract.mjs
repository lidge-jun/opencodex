/**
 * The exit code `ocx stop` uses to say "teardown succeeded, history cleanup did not".
 *
 * This is plain ESM rather than TypeScript because it has two consumers on opposite sides
 * of a process boundary: `src/update/index.ts` and the Node launcher `bin/ocx.mjs`, which
 * cannot import a `.ts` module. A TypeScript union would not survive `spawnSync` anyway —
 * the value has to be on the wire, and an exit code is the wire.
 *
 * 79 is deliberate. It sits above the `sysexits.h` block (64-78), below `128 + signal`,
 * and outside every code this CLI already uses: `src/cli/index.ts` emits 0, 1 and 130,
 * and `src/cli/dispatch.ts` adds 2, 4 and 64. Picking one of those would have made a
 * history-only stop indistinguishable from a config conflict, and `bin/ocx.mjs` mirrors
 * the child's code faithfully enough to propagate the confusion.
 */
export const STOP_HISTORY_INCOMPLETE_EXIT_CODE = 79;

/**
 * The exit code `ocx stop` uses to say "the proxy is down and the shared teardown was
 * refused before it changed anything" (#4718).
 *
 * This is NOT 79. Seventy-nine means the teardown ran: config and catalog came back to
 * their native values and only the Codex history metadata could not be finalized, so the
 * receipt is discharged. Eighty means the Codex history preflight refused FIRST, so
 * config, catalog, history and provenance are all untouched, the client is still routed
 * at the proxy that just stopped, and the receipt stays outstanding for a later stop.
 *
 * Collapsing the two would be a data-loss bug in the quiet direction: a caller reading 79
 * discharges an obligation that was never performed.
 *
 * Eighty sits in the same unoccupied window as 79 — above `sysexits.h` (64-78), below
 * `128 + signal`, and outside 0, 1, 2, 4, 64 and 130, which are the codes this CLI and its
 * dispatcher already emit.
 */
export const STOP_HISTORY_DEFERRED_EXIT_CODE = 80;
