/**
 * The served-by response header and whether this build sends it.
 *
 * Relayed and Hub-served responses are meant to name the Home that served them in
 * `x-opencodex-served-by`, so a peer can prove which Home answered without reading logs. This module
 * is the emitter's descriptor: `SERVED_BY_HEADER_EMITTED` is true only in a build whose responses
 * carry the header, and the change that starts sending it flips the flag in the same commit.
 * `/readyz` advertises `served-by-header` from this flag (`src/remote/features.ts`), and
 * `tests/server/readyz-features.test.ts` fails if the advertisement and live responses disagree.
 */
export const SERVED_BY_HEADER = "x-opencodex-served-by";

/** Whether responses from this build carry {@link SERVED_BY_HEADER}. */
export const SERVED_BY_HEADER_EMITTED: boolean = false;
