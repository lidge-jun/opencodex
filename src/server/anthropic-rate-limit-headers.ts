export function anthropicRateLimitHeaders(upstream: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.forEach((value, name) => {
    if (name.startsWith("anthropic-ratelimit-")) headers[name] = value;
  });
  return headers;
}
