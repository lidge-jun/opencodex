import { isOAuthCredentialSiblingOf } from "../../../src/oauth/credential-siblings";
import type { CatalogPreset } from "./provider-catalog/provider-presets";

/** The row this preset's login publishes when it borrows another provider's login (Kimi (Responses)). */
export function sharedLoginRow(preset: Pick<CatalogPreset, "id" | "oauthProvider">): string | undefined {
  return preset.oauthProvider && isOAuthCredentialSiblingOf(preset.id, preset.oauthProvider) ? preset.id : undefined;
}
