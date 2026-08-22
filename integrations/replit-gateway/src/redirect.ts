export function upstreamFetchPolicy(): RequestInit {
  return { redirect: "manual" };
}

export function assertNoRedirect(response: Response): Response {
  if (response.status >= 300 && response.status < 400) {
    throw new Error("redirect_rejected");
  }
  return response;
}
