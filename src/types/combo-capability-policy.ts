/**
 * How a combo turns its members' capabilities into one catalog row (`capabilityPolicy`).
 *
 * `intersection` (default) advertises only what every member can serve as is: one text-only
 * member removes image input, and the effort ladders intersect. `union` advertises what any
 * member can serve, then picks per request: a member that can serve the request after a local
 * degradation (vision sidecar describes the image, or effort snaps to a supported rung) can
 * stay eligible. The catalog publishes the minimum context window by default for both policies
 * (or the largest when `union` opts into `contextWindowPolicy: "max"`). A degrading union can
 * try the largest compatible window at dispatch. It publishes the minimum max output when every
 * member declares one.
 */
export type OcxComboCapabilityPolicy = "intersection" | "union";

/**
 * How a `union` combo derives its advertised catalog context window (`contextWindowPolicy`).
 * `min` (default, omitted when stored) publishes the smallest member window across targets.
 * `max` opts into advertising the largest member window, input limit, and auto-compact budget
 * when `capabilityPolicy` is `"union"`.
 */
export type OcxComboContextWindowPolicy = "min" | "max";

/**
 * What a `union` combo does when no enabled member can serve the request (`onUnservable`).
 * `degrade` (default) tries the largest compatible window for context or omits unservable images.
 * `reject` answers 400 before dispatch in those cases. Both policies refuse unsupported audio.
 */
export type OcxComboOnUnservable = "degrade" | "reject";
