export interface RequestHistoryFilters {
  provider: string;
  model: string;
  requestedModel: string;
  status: string;
  inboundProtocol: string;
  apiKeyId: string;
  profileId: string;
  fallback: "" | "true" | "false";
}

export const EMPTY_HISTORY_FILTERS: RequestHistoryFilters = {
  provider: "",
  model: "",
  requestedModel: "",
  status: "",
  inboundProtocol: "",
  apiKeyId: "",
  profileId: "",
  fallback: "",
};

export function requestHistoryUrl(apiBase: string, filters: RequestHistoryFilters, cursor?: string): string {
  const query = new URLSearchParams({ limit: "200" });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  if (cursor) query.set("cursor", cursor);
  return `${apiBase}/api/request-history?${query}`;
}
