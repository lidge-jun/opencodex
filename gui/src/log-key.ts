/**
 * Stable log identity. The server assigns every log entry a unique `requestId`
 * (`ocx-${randomBytes(16).hex}`), guaranteed present on all entries returned
 * by the management API. This is the sole clear-view identity key.
 */
export function logKey(requestId: string): string {
  return requestId;
}
