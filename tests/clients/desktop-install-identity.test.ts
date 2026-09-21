import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * The desktop app's half of the runtime-ownership claim.
 *
 * The claim lives in the shared service install state, which core owns across two files: the
 * validation that decides what a record may say is in `src/service/install-state-contract.mjs`,
 * and the types, the three answers a read can give and `ownershipGrantedTo` — the comparison an
 * installation applies to its own locally stored install id — are in `src/service/state.ts`. The
 * shell holds the other half, an id of its own to compare against, and mirrors the rule rather
 * than inventing one, because a weaker version of a question core already answers is how the
 * shell ended up guessing a port it should have been told.
 *
 * Both halves are read here together, so a change on either side breaks this rather than leaving
 * the two to disagree in a place only a takeover would reveal.
 */
const SHELL = "desktop/src-tauri/src";
const IDENTITY = repoPath(`${SHELL}/identity.rs`);
const OWNERSHIP = repoPath(`${SHELL}/ownership.rs`);
const STARTUP = repoPath(`${SHELL}/startup.rs`);
const STATE = repoPath("src/service/state.ts");
const CONTRACT = repoPath("src/service/install-state-contract.mjs");

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("desktop install identity", () => {
  const identity = code(IDENTITY);
  const ownership = code(OWNERSHIP);
  const state = code(STATE);
  const contract = code(CONTRACT);

  test("the installation's id is minted once and never rewritten", () => {
    // Exclusive, because two launches racing to mint would answer to two ids, and the second one
    // would find a claim that is not its own and ask again for consent already given.
    expect(identity).toContain(".create_new(true)");
    const mint = identity.slice(identity.indexOf("pub fn install_id_in"));
    const body = mint.slice(0, mint.indexOf("\n}"));
    expect(body.indexOf("if let Some(existing) = read(&path)")).toBeLessThan(
      body.indexOf("mint(&path)"),
    );
    expect(body).toContain("return Some(existing);");
    // It is the app's own directory, not the shared record: an id stored only in the shared one
    // would be whoever wrote it last.
    expect(identity).toContain("app_config_dir()");
  });

  test("a blank record is replaced rather than answered with", () => {
    expect(identity).toContain("ErrorKind::AlreadyExists");
    const replace = identity.slice(identity.indexOf("ErrorKind::AlreadyExists"));
    expect(replace.slice(0, 300)).toContain("read(&path).is_none()");
  });

  test("the owner values are the ones the record accepts", () => {
    // Both halves of core's answer are read. The runtime rejection is what a record on disk meets,
    // and the exported type is what every caller is compiled against; a parse that accepted a
    // third owner and a type that forbade it would disagree exactly where a takeover happens.
    expect(contract).toContain('value.owner !== "cli" && value.owner !== "desktop"');
    expect(state).toContain('export type ServiceOwner = "cli" | "desktop"');
    expect(ownership).toContain('#[serde(rename_all = "lowercase")]');
    expect(ownership).toContain("    Cli,");
    expect(ownership).toContain("    Desktop,");
  });

  test("the claim's wire fields are the recorded ones", () => {
    for (const field of ["installId", "consentGeneration"]) {
      expect(state).toContain(`ownership.${field}`);
    }
    expect(ownership).toContain('#[serde(rename_all = "camelCase")]');
    expect(ownership).toContain("pub install_id: String");
    expect(ownership).toContain("pub consent_generation: u64");
  });

  test("the three answers a read can give are all three", () => {
    for (const kind of ["none", "owned", "unknown"]) {
      expect(state).toContain(`kind: "${kind}"`);
    }
    expect(ownership).toContain('#[serde(tag = "kind", rename_all = "lowercase")]');
    expect(ownership).toContain("    None,");
    expect(ownership).toContain("Owned { ownership: Claim }");
    expect(ownership).toContain("Unknown { reason: String }");
  });

  test("the comparison is the one the record publishes, and no more", () => {
    const rule = state.slice(state.indexOf("export function ownershipGrantedTo"));
    expect(rule.slice(0, 300)).toContain(
      "ownership.owner === owner && ownership.installId === installId",
    );
    const mirror = ownership.slice(ownership.indexOf("pub fn granted_to"));
    const body = mirror.slice(0, mirror.indexOf("\n}"));
    expect(body).toContain("claim.owner == owner && claim.install_id == install_id");
    // The generation moves on every grant; comparing it would make a held consent look foreign.
    expect(body).not.toContain("consent_generation");
  });

  test("an unreadable record refuses instead of reading as unowned", () => {
    const verdict = ownership.slice(ownership.indexOf("pub fn consent("));
    const body = verdict.slice(0, verdict.indexOf("\n}"));
    expect(body).toContain("Recorded::Unknown { .. } => Consent::Refuse");
    expect(body).toContain("Recorded::None => Consent::AskFirstTime");
  });

  test("the shell does not read the recorded claim itself", () => {
    // Resolving means reading every state path and failing closed on an unreadable one, a corrupt
    // anchor and paths that disagree. That answer belongs to the CLI.
    for (const leak of ["service-state", "serviceStatePaths", "read_to_string", "fs::"]) {
      expect(ownership).not.toContain(leak);
    }
    const seam = ownership.slice(ownership.indexOf("pub fn resolve(_app: &AppHandle)"));
    expect(seam.slice(0, 120)).toContain("None");
  });

  test("not having asked is distinct from nobody owning it", () => {
    // Option::None means the CLI has not been asked; Recorded::None means it answered that no
    // claim exists. Collapsing them would let a takeover proceed on a question never put.
    expect(ownership).toContain("pub fn resolve(_app: &AppHandle) -> Option<Recorded>");
    expect(ownership).toContain("(None, _) => ");
    const startup = code(STARTUP);
    expect(startup).toContain("ownership::describe(ownership::resolve(app).as_ref()");
    expect(startup).toContain("identity::install_id(app)");
    expect(startup).toContain('format!("runtime ownership: {}", registration.identity)');
  });
});
