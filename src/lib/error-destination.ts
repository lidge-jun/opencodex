/** Destination labels are minted locally and revalidated by the error constructor. */
declare const errorDestinationBrand: unique symbol;
export type ErrorDestinationLabel = { readonly [errorDestinationBrand]: true };
const labels = new WeakMap<object, { kind: "origin" | "provider"; value: string }>();
const fallback = "the provider";
const providerId = /^[A-Za-z0-9._-]{1,64}$/;
const schemes = new Set(["http:", "https:", "ws:", "wss:", "socks5:", "socks5h:"]);
function origin(value: unknown): string {
  if (typeof value !== "string") return fallback;
  try {
    const url = new URL(value);
    return schemes.has(url.protocol) && url.hostname.length > 0 && url.hostname.length <= 253
      ? `${url.protocol}//${url.host}` : fallback;
  } catch { return fallback; }
}
function mint(kind: "origin" | "provider", value: string): ErrorDestinationLabel {
  const label = Object.freeze({}) as ErrorDestinationLabel;
  labels.set(label, { kind, value });
  return label;
}
export function errorDestinationLabel(url: string): ErrorDestinationLabel { return mint("origin", origin(url)); }
export function providerErrorDestinationLabel(id: string): ErrorDestinationLabel {
  return mint("provider", typeof id === "string" && providerId.test(id) ? id : fallback);
}
export function errorDestinationText(label: ErrorDestinationLabel): string {
  // Runtime validation also handles callers that supply a value without the branded type.
  const input: unknown = label;
  if (typeof input === "string") return origin(input);
  const owned = input !== null && typeof input === "object" ? labels.get(input) : undefined;
  if (!owned) return fallback;
  return owned.kind === "origin" ? origin(owned.value) : providerId.test(owned.value) ? owned.value : fallback;
}

/** A client selector captured before any route or helper-model rewrite. */
declare const clientModelBrand: unique symbol;
export type ClientFacingModelLabel = { readonly [clientModelBrand]: true };
const clientModels = new WeakMap<object, string>();
const clientModelId = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/;
export function clientFacingModelLabel(requestedModel: unknown, placeholder: "requested" | "unnamed" = "requested"): ClientFacingModelLabel {
  const label = Object.freeze({}) as ClientFacingModelLabel;
  clientModels.set(label, typeof requestedModel === "string" && requestedModel.length <= 128
    && clientModelId.test(requestedModel) ? requestedModel : placeholder === "unnamed" ? "(unnamed)" : "the requested model");
  return label;
}
export function clientFacingModelText(label: ClientFacingModelLabel | undefined): string {
  return label && clientModels.get(label) || "the requested model";
}
