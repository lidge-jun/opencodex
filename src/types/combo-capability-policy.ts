/**
 * How a combo turns its members' capabilities into one catalog row (`capabilityPolicy`).
 *
 * `intersection` (default) advertises only what every member can serve as is: one text-only
 * member removes image input, and the effort ladders intersect. `union` advertises what any
 * member can serve, then picks per request: a member that can serve the request after a local
 * degradation (vision sidecar describes the image, or effort snaps to a supported rung) can
 * stay eligible. The catalog takes the minimum context window for `intersection` and the
 * maximum for `union`. It publishes the minimum max output when every member declares one.
 */
export type OcxComboCapabilityPolicy = "intersection" | "union";

/**
 * What a `union` combo does when no enabled member can serve the request (`onUnservable`).
 * `degrade` (default) tries the largest compatible window for context or omits unservable images.
 * `reject` answers 400 before dispatch in those cases. Both policies refuse unsupported audio.
 */
export type OcxComboOnUnservable = "degrade" | "reject";
