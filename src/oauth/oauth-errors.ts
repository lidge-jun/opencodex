import { errorDestinationText, providerErrorDestinationLabel } from "../lib/error-destination";

export class UnsupportedOAuthProviderError extends Error {
  constructor(provider: string) {
    super(`Unsupported OAuth provider in config: ${errorDestinationText(providerErrorDestinationLabel(provider))}`);
    this.name = "UnsupportedOAuthProviderError";
  }
}

export class OAuthLoginRequiredError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Not logged in to ${errorDestinationText(providerErrorDestinationLabel(provider))}. Run: ocx login ${errorDestinationText(providerErrorDestinationLabel(provider))}`);
    this.name = "OAuthLoginRequiredError";
    this.provider = provider;
  }
}

/** A usable-account caller found needsReauth under the refresh lock; unrestricted joiners retry alone. */
export class OAuthAccountUnusableError extends OAuthLoginRequiredError {}

/** An operator-paused account is temporarily unavailable, not an invalid login. */
export class OAuthAccountPausedError extends Error {
  constructor() {
    super("OAuth account is paused. Resume it in account settings and retry.");
    this.name = "OAuthAccountPausedError";
  }
}

export class OAuthProviderPublicationError extends Error {
  constructor(provider?: string, credentialWritten = true) {
    super(provider !== "anthropic2" ? "OAuth credential was saved, but the provider entry was not written. Resolve the account namespace collision, then retry login."
      : credentialWritten ? "Anthropic Pool 2 credential was saved as an orphan auth row, but the provider entry was not written. Repair the persisted config or resolve the provider/account namespace collision, then retry login."
      : "Anthropic Pool 2 login did not start because the config file is missing or could not be written; no credential was saved. Repair the persisted config, then retry login.");
    this.name = "OAuthProviderPublicationError";
  }
}

/** A local configuration conflict found before any credential is written; its text is fixed. */
export class OAuthProviderNamespaceCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthProviderNamespaceCollisionError";
  }
}

export class OAuthReauthIdentityMismatchError extends Error {
  constructor() {
    super("Signed-in account does not match the selected account. Sign in with the same account.");
    this.name = "OAuthReauthIdentityMismatchError";
  }
}

export class OAuthReauthIdentityUnverifiedError extends Error {
  constructor() {
    super("Could not verify signed-in account identity for reauth.");
    this.name = "OAuthReauthIdentityUnverifiedError";
  }
}

export class OAuthLoginSupersededError extends Error {
  constructor() {
    super("OAuth login was superseded before credential persistence");
    this.name = "OAuthLoginSupersededError";
  }
}
