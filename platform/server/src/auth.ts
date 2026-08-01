import { betterAuth } from "better-auth";
import type { Database } from "./db";
import type { PlatformConfig } from "./config";

export function createPlatformAuth(config: PlatformConfig, database: Database) {
  if (!config.BETTER_AUTH_SECRET || !config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    throw new Error("Better Auth and GitHub OAuth credentials are required");
  }
  return betterAuth({
    appName: "OpenCodex Remote",
    baseURL: config.PLATFORM_BASE_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: database.pool,
    socialProviders: {
      github: {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        scope: ["read:user", "user:email"],
        mapProfileToUser: profile => ({ githubNumericId: String(profile.id) }),
      },
    },
    databaseHooks: {
      account: {
        create: {
          before: async account => account.providerId === "github" ? {
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          } : undefined,
        },
        update: {
          before: async account => account.providerId === "github" ? {
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          } : undefined,
        },
      },
    },
    account: {
      modelName: "accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      accountLinking: { disableImplicitLinking: true },
    },
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        githubNumericId: { type: "string", fieldName: "github_numeric_id", required: false, input: true },
        role: { type: "string", required: false, input: false, defaultValue: "user" },
        status: { type: "string", required: false, input: false, defaultValue: "pending_invite" },
      },
    },
    session: {
      modelName: "sessions",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    verification: {
      modelName: "verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    advanced: {
      cookiePrefix: "__Host-ocxr",
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
    },
  });
}

export type PlatformAuth = ReturnType<typeof createPlatformAuth>;
