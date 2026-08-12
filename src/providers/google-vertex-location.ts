/**
 * Vertex regional hosts are formed as `<location>-aiplatform.googleapis.com`.
 * Restricting the location to one lowercase DNS label keeps user configuration
 * from changing the request authority while remaining forward-compatible with
 * new Google regions and multi-regions.
 */
const GOOGLE_VERTEX_LOCATION_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function googleVertexLocationConfigError(location: unknown): string | null {
  if (typeof location !== "string" || !GOOGLE_VERTEX_LOCATION_LABEL.test(location)) {
    return "Vertex AI location must be a single lowercase Google Cloud location label (for example, us-central1 or global)";
  }
  return null;
}
