import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseServiceOwnershipRecord } from "../../src/service/state-record.mjs";
import { repoPath } from "../helpers/repo-root";

/**
 * The desktop app's half of the runtime-ownership claim.
 *
 * The claim lives in the shared service install state, which core owns across two files: the
 * validation that decides what a record may say is in `src/service/state-record.mjs`,
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
const COMPATIBILITY = repoPath("src/service/ownership-compatibility.ts");
const DESKTOP_SHELL_DOC = repoPath("structure/desktop-shell.md");

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("desktop install identity", () => {
  const identity = code(IDENTITY);
  const ownership = code(OWNERSHIP);
  const state = code(STATE);
  const compatibility = code(COMPATIBILITY);
  const desktopShellDoc = readFileSync(DESKTOP_SHELL_DOC, "utf8");

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
    // Exercise the parser a record on disk actually meets, while also pinning the exported type
    // every caller compiles against. If runtime acceptance and the type diverge, this takeover
    // boundary fails at review instead of after an installation has claimed the runtime.
    const claim = { installId: "install-a", consentGeneration: 1 };
    expect(parseServiceOwnershipRecord({ ...claim, owner: "cli" })).toEqual({ ...claim, owner: "cli" });
    expect(parseServiceOwnershipRecord({ ...claim, owner: "desktop" })).toEqual({ ...claim, owner: "desktop" });
    expect(parseServiceOwnershipRecord({ ...claim, owner: "another-owner" })).toBeNull();
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
    // Each carried revision is the record's own sequence: a later `service claim` repeats it as
    // `expect-revision`, so the takeover is only ever made against the answer it was approved on.
    expect(ownership).toContain("None { revision: u64 }");
    expect(ownership).toContain("Owned { ownership: Claim, revision: u64 }");
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
    expect(body).toContain("Recorded::None { .. } => Consent::AskFirstTime");
  });

  test("the shell does not read the recorded claim itself", () => {
    // Resolving means reading every state path and failing closed on an unreadable one, a corrupt
    // anchor and paths that disagree. That answer belongs to the CLI: it arrives on the resolve
    // document's `ownership` field, parsed by resolve.rs, and a document that does not carry it
    // defaults to unknown rather than to nobody owning it.
    for (const leak of ["service-state", "serviceStatePaths", "read_to_string", "fs::"]) {
      expect(ownership).not.toContain(leak);
    }
    expect(ownership).not.toContain("pub fn resolve(");
    const resolve = code(repoPath(`${SHELL}/resolve.rs`));
    expect(resolve).toContain("pub ownership: Recorded");
  });

  test("an unreported claim is distinct from nobody owning it", () => {
    // A resolve document that carries no ownership field is an older bundled CLI that did not
    // answer, not a runtime with no owner: the default has to read unknown, never none.
    const fallback = ownership.slice(ownership.indexOf("impl Default for Recorded"));
    expect(fallback.slice(0, 200)).toContain("Self::Unknown");
    const startup = code(STARTUP);
    expect(startup).toContain("ownership::describe(&answer.ownership");
    expect(startup).toContain("identity::install_id(app)");
    expect(startup).toContain('"installation id: {}"');
  });

  test("the desktop acceptance text names the consent reuse boundaries", () => {
    expect(desktopShellDoc).toContain("Desktop runtime ownership acceptance");
    expect(desktopShellDoc).toMatch(/same desktop installation reuses consent/i);
    expect(desktopShellDoc).toMatch(/Package update and service repair also preserve that grant/i);
    expect(desktopShellDoc).toMatch(/different `owner`, different `installId`, moved\s+`consentGeneration`/i);
    expect(desktopShellDoc).toMatch(/unreadable ownership record is not reuse/i);
    expect(desktopShellDoc).toMatch(/Uninstall or an explicit handback releases only the live claim/i);
    expect(desktopShellDoc).toMatch(/old package-owned registration is only attachable as a guest/i);
  });

  test("service refresh preserves consent and handback releases only the live claim", () => {
    const writer = state.slice(state.indexOf("export function writeServiceInstallState"));
    const writerBody = writer.slice(0, writer.indexOf("\n}"));
    expect(writerBody).toContain("...preservedConsent(current)");
    const preserve = state.slice(state.indexOf("function preservedConsent"));
    const preserveBody = preserve.slice(0, preserve.indexOf("\n}"));
    expect(preserveBody).toContain("const ownership = current?.ownership");
    expect(preserveBody).toContain("consentGenerationCeiling");
    const release = state.slice(state.indexOf("export function releaseServiceOwner"));
    const releaseBody = release.slice(0, release.indexOf("\n}"));
    expect(releaseBody).toContain("const { ownership: _released, ...withoutOwnership } = current");
    expect(releaseBody).toContain("consentGenerationCeiling");
  });

  test("recording consent revalidates the exact approved subject before reuse", () => {
    expect(state).toContain("export class ServiceOwnershipSubjectMismatchError extends Error");
    expect(state).toContain("export class ServiceOwnershipSubjectUnknownError extends Error");
    const record = state.slice(state.indexOf("export function recordServiceOwner"));
    expect(record).toContain("sameServiceOwnershipSubject(request.expectedSubject, actualSubject)");
    expect(record).toContain("throw new ServiceOwnershipSubjectMismatchError");
    expect(record).toContain("unknownStateError: reason => new ServiceOwnershipSubjectUnknownError");
    // A moved generation is part of the subject, so a pending approval cannot be reused after
    // another writer grants, releases or re-grants ownership.
    const sameSubject = state.slice(state.indexOf("export function sameServiceOwnershipSubject"));
    const sameSubjectBody = sameSubject.slice(0, sameSubject.indexOf("\n}"));
    expect(sameSubjectBody).toContain("left.ownership.consentGeneration === right.ownership.consentGeneration");
  });

  test("old package-owned registrations cannot become durable desktop ownership", () => {
    expect(compatibility).toContain("SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION");
    const assess = compatibility.slice(compatibility.indexOf("export function assessServiceTakeoverCompatibility"));
    expect(assess).toContain('reason: "managing-cli-unsupported"');
    expect(assess).toContain('reason: "service-protocol-unsupported"');
    expect(assess).toContain("input.state?.ownershipProtocolVersion !== SERVICE_OWNERSHIP_PROTOCOL_VERSION");
  });
});
