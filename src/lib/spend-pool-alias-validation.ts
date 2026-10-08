import { createHash } from "node:crypto";
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, type Stats } from "node:fs";
import { join } from "node:path";

/** Read an existing single-owner salt without creating or hardening any file. */
export function readExistingSpendSalt(home: string): string | undefined {
  let fd: number | undefined;
  let salt: string | undefined;
  try {
    const path = join(home, "spend-ledger.salt");
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1) return undefined;
    const matches = (stat: Stats): boolean => stat.isFile() && stat.nlink === 1
      && stat.dev === before.dev && stat.ino === before.ino;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!matches(fstatSync(fd))) return undefined;
    const contents = readFileSync(fd, "utf8").trim();
    if (matches(fstatSync(fd)) && matches(lstatSync(path)) && /^[0-9a-f]{32,}$/.test(contents)) salt = contents;
  } catch { salt = undefined; }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { salt = undefined; }
    }
  }
  return salt;
}

/**
 * The one owner of the spend ledger's salted alias hash. The ledger, config diagnostics and
 * runtime policy validation must all compute the same alias for the same (salt, domain, id),
 * so the hash lives here and nowhere else. The raw id never leaves this function.
 */
export function hashSpendAlias(salt: string, kind: string, id: string): string {
  return createHash("sha256").update(salt).update("\u0000").update(kind).update("\u0000").update(id)
    .digest("hex").slice(0, 32);
}

const isAlias = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/** Shape and optional roster check, outside `spend` so old schemas keep configured ceilings. */
export function spendPoolAliasesError(value: unknown, providerIds?: Iterable<string>): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "spendPoolAliases must be an object";
  if (Object.keys(value).length > 4_096) return "spendPoolAliases has too many entries";
  const providers = providerIds === undefined ? undefined : new Set(providerIds);
  for (const [alias, provider] of Object.entries(value)) {
    if (!isAlias(alias) || typeof provider !== "string" || !provider.trim() || provider.trim() !== provider || provider.length > 256) {
      return "spendPoolAliases requires exact 32-character salted pool aliases and nonempty provider IDs";
    }
    if (providers && !providers.has(provider)) return "spendPoolAliases targets a provider that is not configured";
  }
  return undefined;
}

/**
 * Semantic owner check: an alias that is the salted pool alias of a configured provider P
 * belongs to P. Mapping it to any other provider Q would move P's own history into Q's pool,
 * so `aliases[h("pool", P)] = Q` with Q !== P is rejected. Re-run whenever the provider set
 * changes: adding P later turns an existing mapping into a conflict.
 */
export function validatePoolAliasOwners(
  aliases: unknown,
  salt: string,
  providerIds: Iterable<string>,
): string | undefined {
  const shape = spendPoolAliasesError(aliases);
  if (shape) return shape;
  if (aliases === undefined) return undefined;
  const mapping = aliases as Record<string, string>;
  for (const provider of new Set(providerIds)) {
    const owned = hashSpendAlias(salt, "pool", provider);
    const target = Object.hasOwn(mapping, owned) ? mapping[owned] : undefined;
    if (target !== undefined && target !== provider) {
      return "spendPoolAliases maps a configured provider's own pool alias to a different provider";
    }
  }
  return undefined;
}
