import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Local agent/session state must never reach a commit.
 *
 * `.gitignore` alone does not enforce this: `git add -f` overrides it silently,
 * and once a path is tracked the ignore rule stops applying to it entirely. The
 * `.codexclaw/` goalplans and ledgers were committed exactly that way and rode
 * along into `main` and `preview` before anyone noticed.
 *
 * This test closes that gap by asserting against the real index instead of the
 * ignore file, so a forced add fails CI on the commit that introduces it.
 */
const FORBIDDEN_TRACKED_DIRS = [".codexclaw", ".omo", ".claude", "node_modules", ".tmp"];

const FORBIDDEN_TRACKED_FILENAMES = [".DS_Store", "Thumbs.db"];

/**
 * The retired Go native-runtime experiment. Nothing in `src/`, the build, the
 * typecheck, or the test path reads from `go/`, so a tracked file there is always
 * an accident — and this specific one is a repeat offender: `git add -A` pulled
 * `go/internal/cli/config_parity.go` back into the index three times during the
 * #820 campaign, and the third one rode a merge into `dev`. `.gitignore` cannot
 * catch that on its own, because an already-tracked path ignores the rule.
 */
const RETIRED_TRACKED_DIRS = ["go"];

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function trackedEntries(): { mode: string; path: string }[] {
  const result = Bun.spawnSync(["git", "ls-files", "-s"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files -s failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { mode: meta?.split(" ")[0] ?? "", path: path ?? "" };
    });
}

describe("repository hygiene", () => {
  test("no local agent or session state is tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      path.split("/").some((segment) => FORBIDDEN_TRACKED_DIRS.includes(segment)),
    );

    expect(offenders).toEqual([]);
  });

  test("no OS metadata files are tracked", () => {
    const offenders = trackedFiles().filter((path) =>
      FORBIDDEN_TRACKED_FILENAMES.includes(path.split("/").pop() ?? ""),
    );

    expect(offenders).toEqual([]);
  });

  test("the retired Go runtime stays untracked", () => {
    const offenders = trackedFiles().filter((path) =>
      RETIRED_TRACKED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`)),
    );

    expect(offenders).toEqual([]);
  });

  test("gitignore still declares the agent-state directories", async () => {
    const ignore = await Bun.file(new URL("../.gitignore", import.meta.url)).text();

    for (const dir of FORBIDDEN_TRACKED_DIRS) {
      expect(ignore).toContain(`${dir}/`);
    }

    for (const dir of RETIRED_TRACKED_DIRS) {
      expect(ignore).toContain(`${dir}/`);
    }
  });
});

/**
 * `devlog/` notes are tracked in this repository, and no submodule remains.
 *
 * The failure mode this locks down has already happened twice: a `160000` gitlink
 * lands in the index for a path no workflow initializes, and `actions/checkout`
 * fails for every contributor. With devlog converted to ordinary files the
 * invariant is simpler and stronger — there is no gitlink at all.
 *
 * The vendored and excision guards matter more than they look. devlog used to carry
 * its own `.gitignore`, which stopped applying the moment it became part of this
 * repository. Without these assertions a future `git add -A` would pull 129 MB of
 * third-party source, or re-introduce security triage that was deliberately excised.
 */
describe("devlog is tracked, with no submodule left behind", () => {
  test("no gitlink is tracked anywhere", () => {
    const gitlinks = trackedEntries().filter((entry) => entry.mode === "160000");

    expect(gitlinks.map((entry) => entry.path)).toEqual([]);
  });

  test("devlog markdown is tracked as ordinary blobs", () => {
    const devlogFiles = trackedFiles().filter((path) => path.startsWith("devlog/"));

    expect(devlogFiles.length).toBeGreaterThan(1000);
    expect(devlogFiles.some((path) => path.endsWith(".md"))).toBe(true);
  });

  test("no .gitmodules file remains", () => {
    expect(existsSync(new URL("../.gitmodules", import.meta.url))).toBe(false);
  });

  test("vendored reference clones stay untracked", () => {
    const vendored = trackedFiles().filter(
      (path) =>
        path.startsWith("devlog/_chase/_litellm/")
        || path.startsWith("devlog/_chase/_cca/")
        || path.startsWith("devlog/_chase/DSCodex/")
        || path.startsWith("devlog/_fin/opencode-cursor/"),
    );

    expect(vendored).toEqual([]);
  });

  test("security triage excised before publication stays untracked", () => {
    const excised = trackedFiles().filter((path) =>
      /^devlog\/_plan\/260730_(?:open_pr_backlog|new_issue_pr)_triage\//.test(path),
    );

    expect(excised).toEqual([]);
  });

  /**
   * Documents that describe the policy itself necessarily quote its vocabulary. This
   * unit is the conversion's own paper trail: it names the verdict markers and the
   * boundary terms in order to define what the tripwire looks for. Exempting it is
   * narrow and path-pinned — a NEW unit gets no exemption, so the check still fires
   * for real triage.
   *
   * The unit closed and moved to `_fin/` (devlog/_fin/260805_devlog_fin_sweep), which
   * makes this exemption redundant: the scan below reads `_plan/` only. It is repointed
   * rather than deleted so the reason survives — if the unit ever returns to `_plan/`,
   * or a reader asks why the tripwire tolerates a document full of its own trigger
   * words, the answer is still here.
   */
  const TRIPWIRE_META_EXEMPT_PREFIX = "devlog/_fin/260730_devlog_publication_feasibility/";

  /**
   * Security-boundary vocabulary, in both languages this devlog is written in.
   *
   * The English-only first draft of this list did NOT catch the very document that
   * motivated the excision: its verdicts are English markers but its prose is Korean
   * ("크리덴셜 경계 보안 리뷰"). A tripwire that misses the case it was built for is
   * worse than no tripwire, because it reads as coverage.
   */
  const SECURITY_BOUNDARY_RE =
    /account.boundary|credential destination|auth bypass|unauthenticated endpoint|account pool|크리덴셜|자격 ?증명|계정 경계|인증 우회|미인증/i;

  /**
   * Tripwire for the rule that replaced repository privacy.
   *
   * This cannot detect every pre-disclosure note — prose is not checkable — but it
   * catches the shape the violation actually took: an OPEN triage document under
   * `_plan/` carrying an unresolved review verdict AND discussing a security
   * boundary. Both signals are required, because an open plan that merely mentions
   * auth is ordinary work.
   *
   * `_fin/` is exempt by design. A closed unit documents a shipped fix, so its
   * writeup discloses nothing a public diff does not; applying this check there
   * would fail on the very hardening records that are safe to publish.
   *
   * Driven red once during the conversion to prove it is not vacuous.
   */
  test("no open devlog plan carries an unresolved security verdict", async () => {
    const openPlans = trackedFiles().filter(
      (path) =>
        path.startsWith("devlog/_plan/")
        && path.endsWith(".md")
        && !path.startsWith(TRIPWIRE_META_EXEMPT_PREFIX),
    );

    expect(openPlans.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const path of openPlans) {
      const text = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
      const unresolved = /NEEDS-SECURITY-REVIEW|NEEDS-CHANGES/.test(text);
      if (unresolved && SECURITY_BOUNDARY_RE.test(text)) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  test("no workflow checks out submodules", async () => {
    const listing = Bun.spawnSync(["git", "ls-files", ".github/workflows"], { cwd: repoRoot });
    const workflows = new TextDecoder()
      .decode(listing.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(workflows.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const workflow of workflows) {
      const text = await Bun.file(new URL(`../${workflow}`, import.meta.url)).text();
      // `submodules: false` is fine; anything that opts in is not.
      if (/submodules:\s*(true|recursive)/.test(text)) offenders.push(workflow);
      if (/git submodule update[^\n]*devlog/.test(text)) offenders.push(workflow);
    }

    expect(offenders).toEqual([]);
  });
  test("every relative README asset is actually shipped in the npm tarball", async () => {
    // npm renders README.md on the package page, and a relative src there resolves inside the
    // published tarball. Three GIFs were referenced relatively while `files` shipped only one, so
    // the package page rendered three broken images - visible to every visitor, invisible to every
    // gate. Absolute URLs are the deliberate alternative: the GIFs total ~3.3MB and there is no
    // reason to put that in the install path of a proxy.
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as {
      files?: string[];
    };
    const shipped = pkg.files ?? [];
    expect(shipped.length).toBeGreaterThan(0);

    // No lower bound on the match count: switching every image to an absolute URL is a legitimate
    // end state, and a `toBeGreaterThan(0)` guard here would fail the suite for doing it.
    const relative = [...readme.matchAll(/src="(?!https?:)([^"]+)"/g)].map((match) => match[1]!);

    // A directory entry ships everything beneath it; a regular-file entry ships only itself.
    // Deciding that by prefix alone let `assets/banner.png` vouch for a nonexistent
    // `assets/banner.png/missing.gif`, so a broken README reference could pass. Ask the
    // filesystem what each entry actually is instead of inferring it from the name.
    const shippedDirectories = shipped.filter((entry) => {
      const path = new URL(`../${entry}`, import.meta.url);
      return existsSync(path) && statSync(path).isDirectory();
    });
    const isShipped = (asset: string): boolean =>
      shipped.includes(asset)
      || shippedDirectories.some((directory) => asset.startsWith(`${directory}/`));

    expect(isShipped("assets/banner.png/missing.gif")).toBe(false);
    expect(isShipped("LICENSE/missing.png")).toBe(false);

    const missing = relative.filter((asset) => !isShipped(asset));
    expect(missing).toEqual([]);
  });
});
