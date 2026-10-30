/** Content-free discovery observations. Never enumerate upstream keys or serialize its objects. */
function projectValueType(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "string") return "string";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return typeof (value as { id?: unknown }).id === "string" ? "object-with-id" : "object-without-id";
  }
  return "other";
}

function projectTypes(data: unknown): Record<string, string> {
  const object = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown> : undefined;
  return {
    cloudaicompanionProject: projectValueType(object?.cloudaicompanionProject),
    projectId: projectValueType(object?.projectId),
    project: projectValueType(object?.project),
  };
}

/** Published only when the existing parser did not discover a project; never used for admission.
 * `undefined` means JSON was unparseable or, for HTTP refusals, deliberately not inspected.
 */
export function summarizeAntigravityDiscovery(
  stage: "loadCodeAssist" | "onboardUser",
  status: number,
  data: unknown,
): string {
  const root = data === undefined ? "unparseable" : Array.isArray(data) ? "array"
    : data && typeof data === "object" ? "object" : "other";
  const object = root === "object" ? data as Record<string, unknown> : undefined;
  const done = object?.done === undefined ? "absent" : object.done === true ? "true"
    : object.done === false ? "false" : "other";
  const error = object && Object.hasOwn(object, "error") ? "present" : "absent";
  const outcome = status < 200 || status >= 300 ? "http-refusal"
    : root === "unparseable" ? "unparseable" : root !== "object" ? "invalid-root"
    : stage === "loadCodeAssist" ? "no-project"
    : done !== "true" ? "pending" : error === "present" ? "done-with-error" : "done-without-project";
  return JSON.stringify({
    stage, status, root, outcome, done, error,
    projects: projectTypes(object),
    response: projectTypes(object?.response),
  });
}

const DISCOVERY_FAILURE_MESSAGE = "Antigravity login could not discover a Cloud Code Assist project for this account. Ensure the account has Antigravity/Cloud Code Assist access and try again.";

/** Only sanitizer outputs can enter this error's public message; raw responses are never retained. */
export class AntigravityProjectDiscoveryError extends Error {
  #summaries: string[] = [];

  constructor() {
    super(DISCOVERY_FAILURE_MESSAGE);
    this.name = "AntigravityProjectDiscoveryError";
  }

  observe(stage: "loadCodeAssist" | "onboardUser", status: number, data: unknown): void {
    this.#summaries[stage === "loadCodeAssist" ? 0 : 1] = summarizeAntigravityDiscovery(stage, status, data);
    this.message = this.publicMessage;
  }

  get publicMessage(): string {
    return `${DISCOVERY_FAILURE_MESSAGE} Discovery: ${this.#summaries.join("; ")}`;
  }
}
