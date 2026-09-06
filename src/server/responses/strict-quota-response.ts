/** Process-local proof: an upstream header alone never authorizes replaying a request. */
const waitableResponses = new WeakSet<Response>();
export function markStrictQuotaWaitResponse(response: Response): Response {
  response.headers.set("x-opencodex-quota-wait", "1");
  waitableResponses.add(response);
  return response;
}
export function isStrictQuotaWaitResponse(response: Response): boolean {
  return waitableResponses.has(response);
}
