import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const gate = join(repoRoot, "scripts", "ci", "assert-mergeable-review.sh");
const fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-mergeable-review-"));
const mockBin = join(fixtureRoot, "bin");

const fakeGh = `#!/usr/bin/env bash
set -euo pipefail

case_name="$CASE_NAME"

review() {
  local login="$1"
  local state="$2"
  local commit="$3"
  local submitted="$4"
  local id="$5"
  local type="User"
  if [ "$#" -ge 6 ]; then
    type="$6"
  fi
  printf '{"user":{"login":"%s","type":"%s"},"state":"%s","commit_id":"%s","submitted_at":"%s","id":%s}' \
    "$login" "$type" "$state" "$commit" "$submitted" "$id"
}

if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if printf '%s\n' "$*" | grep -q 'reviewDecision'; then
    case "$case_name" in
      decision_api_failure) exit 71 ;;
      decision_not_approved) printf '%s\n' 'REVIEW_REQUIRED'; exit 0 ;;
      decision_missing) printf '%s\n' ''; exit 0 ;;
      *) printf '%s\n' 'APPROVED'; exit 0 ;;
    esac
  fi

  case "$case_name" in
    meta_api_failure) exit 72 ;;
    missing_head) printf '%s\n' '{"headRefOid":null,"author":{"login":"author"},"title":"fixture"}' ;;
    missing_author) printf '%s\n' '{"headRefOid":"HEADSHA","author":null,"title":"fixture"}' ;;
    self_approval|case_variant_self_approval) printf '%s\n' '{"headRefOid":"HEADSHA","author":{"login":"lidge-jun"},"title":"fixture"}' ;;
    head_changes_after_meta)
      if [ -f "$CASE_STATE_DIR/meta-read" ]; then
        printf '%s\n' '{"headRefOid":"NEWSHA","author":{"login":"author"},"title":"fixture"}'
      else
        : > "$CASE_STATE_DIR/meta-read"
        printf '%s\n' '{"headRefOid":"OLDSHA","author":{"login":"author"},"title":"fixture"}'
      fi
      ;;
    *) printf '%s\n' '{"headRefOid":"HEADSHA","author":{"login":"author"},"title":"fixture"}' ;;
  esac
  exit 0
fi

if [ "$1" = "api" ]; then
  if printf '%s\n' "$2" | grep -q '/contents/MAINTAINERS.md'; then
    if [ "$case_name" = "roster_api_failure" ]; then
      exit 73
    fi
    if [ "$case_name" = "empty_roster" ]; then
      printf '%b' '# Maintainers\n\n## Current maintainers\n\n## Former maintainers\n' | base64
      exit 0
    fi
    if [ "$case_name" = "bot_rostered" ]; then
      printf '%b' '# Maintainers\n\n## Current maintainers\n\n| [@lidge-jun](x) | owner |\n| [@Ingwannu](x) | maintainer |\n| [@coderabbitai](x) | automation |\n\n## Former maintainers\n' | base64
      exit 0
    fi
    if [ "$case_name" = "case_variant_self_approval" ]; then
      printf '%b' '# Maintainers\n\n## Current maintainers\n\n| [@LIDGE-JUN](x) | owner |\n| [@Ingwannu](x) | maintainer |\n\n## Former maintainers\n' | base64
      exit 0
    fi
    printf '%b' '# Maintainers\n\n## Current maintainers\n\n| [@lidge-jun](x) | owner |\n| [@Ingwannu](x) | maintainer |\n\n## Former maintainers\n' | base64
    exit 0
  fi

  if printf '%s\n' "$2" | grep -q '/reviews'; then
    case "$case_name" in
      review_api_failure)
        printf '%s\n' '[[{"user":{"login":"Ingwannu"},"state":"APPROVED","commit_id":"HEADSHA","submitted_at":"2026-08-29T00:00:00Z","id":1}]]'
        exit 74
        ;;
      malformed_reviews)
        printf '%s\n' 'not-json'
        ;;
      zero_reviews|decision_not_approved|decision_missing|meta_api_failure|missing_head|roster_api_failure|empty_roster|decision_api_failure)
        printf '%s\n' '[[]]'
        ;;
      happy_exact)
        printf '[['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf ']]\n'
        ;;
      approve_then_changes)
        printf '[['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf ','; review Ingwannu CHANGES_REQUESTED HEADSHA 2026-08-29T00:01:00Z 2; printf ']]\n'
        ;;
      stale_approval)
        printf '[['; review Ingwannu APPROVED OLDSHA 2026-08-29T00:00:00Z 1; printf ']]\n'
        ;;
      self_approval)
        printf '[['; review lidge-jun APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf ']]\n'
        ;;
      case_variant_self_approval)
        printf '[['; review LIDGE-JUN APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf ']]\n'
        ;;
      outside_approval)
        printf '[['; review outsider APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf ']]\n'
        ;;
      maintainer_blocker_same_page)
        printf '[['; review lidge-jun CHANGES_REQUESTED HEADSHA 2026-08-29T00:00:00Z 1; printf ','; review Ingwannu APPROVED HEADSHA 2026-08-29T00:01:00Z 2; printf ']]\n'
        ;;
      maintainer_blocker_multi_page)
        printf '[['; review lidge-jun CHANGES_REQUESTED HEADSHA 2026-08-29T00:00:00Z 1; printf ','; review outsider COMMENTED HEADSHA 2026-08-29T00:00:30Z 2; printf '],['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:01:00Z 3; printf ']]\n'
        ;;
      dismissed_after_approval)
        printf '[['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf '],['; review Ingwannu DISMISSED HEADSHA 2026-08-29T00:01:00Z 2; printf ']]\n'
        ;;
      pending_after_approval)
        printf '[['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf '],['; review Ingwannu PENDING HEADSHA 2026-08-29T00:01:00Z 2; printf ']]\n'
        ;;
      comment_after_approval)
        printf '[['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf '],['; review Ingwannu COMMENTED HEADSHA 2026-08-29T00:01:00Z 2; printf ']]\n'
        ;;
      case_variant_latest_blocker)
        printf '[['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf '],['; review ingwannu CHANGES_REQUESTED HEADSHA 2026-08-29T00:01:00Z 2; printf ']]\n'
        ;;
      bot_outside_roster|bot_rostered)
        printf '[['; review 'coderabbitai[bot]' APPROVED HEADSHA 2026-08-29T00:00:00Z 1 Bot; printf ']]\n'
        ;;
      head_changes_after_meta)
        printf '[['; review Ingwannu APPROVED OLDSHA 2026-08-29T00:00:00Z 1; printf ']]\n'
        ;;
      missing_author)
        printf '[['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf ']]\n'
        ;;
      missing_commit)
        printf '%s\n' '[[{"user":{"login":"Ingwannu","type":"User"},"state":"APPROVED","submitted_at":"2026-08-29T00:00:00Z","id":1}]]'
        ;;
      decision_not_approved|decision_missing)
        printf '[['; review Ingwannu APPROVED HEADSHA 2026-08-29T00:00:00Z 1; printf ']]\n'
        ;;
      *)
        printf '%s\n' '[[]]'
        ;;
    esac
    exit 0
  fi
fi

printf 'unexpected gh invocation: %s\n' "$*" >&2
exit 75
`;

const cases = [
  ["happy_exact", "PASS"],
  ["approve_then_changes", "FAIL"],
  ["stale_approval", "FAIL"],
  ["self_approval", "FAIL"],
  ["outside_approval", "FAIL"],
  ["maintainer_blocker_same_page", "FAIL"],
  ["maintainer_blocker_multi_page", "FAIL"],
  ["decision_not_approved", "FAIL"],
  ["review_api_failure", "FAIL"],
  ["roster_api_failure", "FAIL"],
  ["meta_api_failure", "FAIL"],
  ["decision_api_failure", "FAIL"],
  ["malformed_reviews", "FAIL"],
  ["missing_head", "FAIL"],
  ["missing_author", "FAIL"],
  ["missing_commit", "FAIL"],
  ["empty_roster", "FAIL"],
  ["zero_reviews", "FAIL"],
  ["dismissed_after_approval", "FAIL"],
  ["pending_after_approval", "FAIL"],
  ["comment_after_approval", "PASS"],
  ["case_variant_latest_blocker", "FAIL"],
  ["case_variant_self_approval", "FAIL"],
  ["bot_outside_roster", "FAIL"],
  ["bot_rostered", "FAIL"],
  ["head_changes_after_meta", "FAIL"],
] as const;

beforeAll(() => {
  mkdirSync(mockBin);
  const fakeGhPath = join(mockBin, "gh");
  writeFileSync(fakeGhPath, fakeGh, "utf8");
  chmodSync(fakeGhPath, 0o755);
});

afterAll(() => {
  removeTreeWithRetry(fixtureRoot);
});

describe.skipIf(process.platform === "win32")("assert-mergeable-review", () => {
  for (const [name, expected] of cases) {
    test(name, () => {
      const caseStateDir = join(fixtureRoot, name);
      mkdirSync(caseStateDir);
      const result = Bun.spawnSync(["bash", gate, "999", "fixture/repo"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CASE_NAME: name,
          CASE_STATE_DIR: caseStateDir,
          PATH: `${mockBin}${delimiter}${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

      if (expected === "PASS") {
        expect(result.exitCode, output).toBe(0);
      } else {
        expect(result.exitCode, output).not.toBe(0);
      }
    });
  }
});
