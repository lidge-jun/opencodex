/** Placeholder shown before the draft id/alias can form a public model id. */
export const PUBLIC_MODEL_PREVIEW_PLACEHOLDER = "…";

/** True when the preview value is a real public model id clients can request. */
export function canCopyPublicModelId(model: string): boolean {
  return model.trim().length > 0 && model !== PUBLIC_MODEL_PREVIEW_PLACEHOLDER;
}
