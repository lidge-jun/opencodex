/** CL-04 read-surface errors — safe codes only, no SQLite/path leakage. */

export class LabProjectionUnavailableError extends Error {
  readonly code = "lab_projection_unavailable" as const;
  constructor() {
    super("lab projection is not available");
  }
}

export class LabProjectionIncompatibleError extends Error {
  readonly code = "lab_projection_incompatible" as const;
  constructor() {
    super("lab projection schema or spec version is incompatible");
  }
}

export class InvalidCursorError extends Error {
  readonly code = "invalid_cursor" as const;
  constructor() {
    super("invalid cursor");
  }
}
