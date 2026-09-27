import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { withClientLifecycle } from "../../client/lifecycle-lock";
import { hardenSecretDirAsync, hardenSecretPathAsync } from "../../lib/windows-secret-acl";

export interface DesktopConnectionIdentity {
  version: 1;
  id: string;
  connectPort: number;
  pacPort: number;
}
export interface DesktopConnectionStore {
  read(): DesktopConnectionIdentity | null;
  publish(value: DesktopConnectionIdentity): Promise<DesktopConnectionIdentity>;
}
const FILE = "connection.json";
const fail = (reason: "invalid" | "changed" | "cleanup_required", cause?: unknown) => new Error(`desktop_compatibility_connection_${reason}`, { cause });
const port = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
function validate(value: unknown): DesktopConnectionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("invalid");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || row.version !== 1 || typeof row.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id)
    || !port(row.connectPort) || !port(row.pacPort) || row.connectPort === row.pacPort) throw fail("invalid");
  return { version: 1, id: row.id, connectPort: row.connectPort, pacPort: row.pacPort };
}
function assertPath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 4096)) throw fail("invalid");
}
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw fail("invalid"); }
}
function same(left: DesktopConnectionIdentity, right: DesktopConnectionIdentity): boolean {
  return left.version === right.version && left.id === right.id && left.connectPort === right.connectPort && left.pacPort === right.pacPort;
}

/** Public endpoint identity only. No token, account, private key or expiry is persisted here. */
export function createDesktopConnectionStore(directory: string): DesktopConnectionStore {
  if (!isAbsolute(directory)) throw fail("invalid");
  const path = join(directory, FILE);
  const read = (): DesktopConnectionIdentity | null => {
    try {
      if (!present(directory)) return null;
      assertPath(directory, true);
      if (!present(path)) return null;
      assertPath(path, false);
      return validate(JSON.parse(readFileSync(path, "utf8")));
    } catch { throw fail("invalid"); }
  };
  const verifyExisting = (value: DesktopConnectionIdentity): DesktopConnectionIdentity | null => {
    const existing = read();
    if (existing && !same(existing, value)) throw fail("changed");
    return existing;
  };
  return { read, async publish(input) {
    const value = validate(input);
    const existing = verifyExisting(value); if (existing) return existing;
    // A trusted authority must already own this directory. Never create a replacement home.
    assertPath(directory, true); await hardenSecretDirAsync(directory, { required: true });
    return withClientLifecycle(async () => {
      const raced = verifyExisting(value); if (raced) return raced;
      const temporary = join(directory, `connection-${randomUUID()}.tmp`);
      let created = false;
      try {
        const fd = openSync(temporary, "wx", 0o600); created = true;
        try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
        await hardenSecretPathAsync(temporary, { required: true });
        assertPath(directory, true); assertPath(temporary, false);
        // Create-only publication cannot overwrite another process's endpoint identity.
        try { linkSync(temporary, path); }
        catch (error) {
          const winner = verifyExisting(value); if (!winner) throw error;
        }
        unlinkSync(temporary); created = false;
        const published = verifyExisting(value); if (!published) throw fail("changed");
        return published;
      } catch (error) {
        try { if (created && present(temporary)) unlinkSync(temporary); }
        catch (cleanupError) { throw fail("cleanup_required", new AggregateError([error, cleanupError], "Endpoint publication and cleanup failed")); }
        throw error;
      }
    }, { lockPath: join(directory, "connection-publication.sqlite") });
  } };
}
