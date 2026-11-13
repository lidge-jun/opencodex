/**
 * How a combo turns its members' capabilities into one catalog row (`capabilityPolicy`).
 *
 * `intersection` (default) advertises only what every member can serve as is: one text-only
 * member removes image input, and the effort ladders intersect. `union` advertises what any
 * member can serve, then picks per request: a member that can serve the request after a local
 * degradation (vision sidecar describes the image, the effort snaps down its own ladder) is
 * still used, and only a member that cannot serve it at all is skipped. Context window and
 * max output stay the minimum under both policies, because a window cannot be degraded into.
 */
export type OcxComboCapabilityPolicy = "intersection" | "union";

/**
 * What a `union` combo does when no enabled member can serve the request (`onUnservable`).
 * `degrade` (default) dispatches anyway, and the child strips the images it cannot describe.
 * `reject` answers 400 instead.
 */
export type OcxComboOnUnservable = "degrade" | "reject";
