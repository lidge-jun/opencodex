import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { MuseMspError } from "./connection";

/** Ephemeral host settings; credentials are never copied implicitly and require explicit provisioning. */
export async function createMuseIsolatedSettings(developerPrompt: string | undefined, baseEnv: NodeJS.ProcessEnv, provision?: {
  endpointTransport?: { base_url: string; auth: string };
  writeCredentials: (configDir: string) => Promise<void>;
  disableReminders?: true;
  /** Opt in only when the supplied host environment intentionally owns this credential. */
  useMetaApiKeyEnv?: true;
}): Promise<{
  env: NodeJS.ProcessEnv; close: () => Promise<void>;
}> {
  if (developerPrompt !== undefined && (typeof developerPrompt !== "string" || !developerPrompt || Buffer.byteLength(developerPrompt) > 1024 * 1024)) throw new MuseMspError("invalid_developer_prompt");
  const root = resolve(tmpdir());
  const folder = resolve(await mkdtemp(join(root, "ocx-muse-")));
  if (!folder.startsWith(root + sep) || !basename(folder).startsWith("ocx-muse-")) throw new MuseMspError("invalid_temp_directory");
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // The sole recursive deletion is the just-created, verified temporary directory.
    if (!folder.startsWith(root + sep) || !basename(folder).startsWith("ocx-muse-")) throw new MuseMspError("invalid_temp_directory");
    await rm(folder, { recursive: true, force: true });
  };
  try {
    const configDir = join(folder, ".config"), dataDir = join(folder, ".local", "share");
    await mkdir(join(configDir, "muse"), { recursive: true, mode: 0o700 });
    await writeFile(join(configDir, "muse", "settings.json"), JSON.stringify({ schema_version: 1,
      ...(provision?.endpointTransport ? { endpoint_transport: provision.endpointTransport } : {}),
      permissions: { schema_version: 1, default_profile: ":ask-me" }, run: { ...(developerPrompt === undefined ? {} : { developer_prompt: developerPrompt }),
        ...(provision?.disableReminders ? { reminder_roster: { agents: [] } } : {}) } }),
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (provision) await provision.writeCredentials(join(configDir, "muse"));
    const env: NodeJS.ProcessEnv = { ...baseEnv, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir,
      APPDATA: join(folder, "AppData", "Roaming"), LOCALAPPDATA: join(folder, "AppData", "Local"), TEMP: folder, TMP: folder };
    // Muse prioritizes this environment key over auth.json. Isolating HOME must
    // not accidentally retain an inherited credential, even without provisioning.
    if (!provision?.useMetaApiKeyEnv) for (const key of Object.keys(env)) if (key.toUpperCase() === "META_API_KEY") delete env[key];
    return { env, close };
  } catch (error) { await close(); throw error; }
}
