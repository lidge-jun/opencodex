/** The latest failed attempt overrides retained data; before the first reply, the loaded dashboard is assumed reachable. */
export function proxyHealthOnline(data: unknown, error: unknown): boolean {
  return error == null && data !== null;
}
