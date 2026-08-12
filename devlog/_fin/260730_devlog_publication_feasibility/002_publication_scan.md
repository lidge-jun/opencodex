# 002 — Publication scan result: UNSAFE as-is

Research only. Scope: the devlog publication set. Values are redacted throughout; this
document records classifications and locations, never secret material.

## Verdict

**UNSAFE for bulk publication.** Not because of credentials — those came back clean —
but because of two tracked security documents and a broad personal-data surface.

## A. Credentials — CLEAN

16 fixed-format matches, every one a sentinel, placeholder, or false positive:

- test/mock keys in an explicitly-labelled `TEST_KEY_PATTERNS.md`
- a Hugging Face model identifier that merely starts with `sk-`
- documented redaction-test sentinels in four `_fin` units
- a scanner-regression example using an `AKIA` prefix
- test fixture values in `_plan/260730_prerelease_blockers/010_...md`

41 env-style assignment matches, all non-secret: static test passwords, secret-manager
ARNs, `${VAR}` indirection, and "your key here" placeholders.

Note for future scans: a bare `[A-Za-z0-9_-]{32,}` blob pattern is useless here — it
produced 37,077 false positives from ordinary prose and identifiers. Use entropy plus
context suppression for `sha`/`hash`/`commit`/`digest`.

## B. Embargoed security material — THE BLOCKER

589 security-term hits across 273 markdown files. Two are publication blockers, and both
are `git ls-files`-tracked:

| File | Why it blocks |
|---|---|
| `_fin/280_codex-multi-auth-security-patch-plan/00_patch_plan.md` | An explicit security patch plan. States that external reviews "found account-boundary failures that must be fixed before main merge", then details fail-closed requirements for pool credentials, WebSocket upgrade paths, deleted-account binding, and sidecar auth. No in-document evidence of public disclosure. |
| `_fin/145_common-security-hardening/00_plan.md` | Shared security-hardening roadmap with attack-surface detail. No disclosure evidence. |

`_fin` means the unit was closed, not that the finding was disclosed. Verifying actual
disclosure status requires checking advisories and release notes, which is a maintainer
judgment call, not an inference an agent should make.

A second tier is already-public and therefore not blocking: the closed public issues #701,
#688, #295/#300, #175, #292.

The account-selection review that was originally cited here has since been EXCISED from
the publication set (see `003`), so it is deliberately not named. Superseded conclusions in
this document are corrected in `003`; read that first.

## C. Personal and third-party data — needs sanitization

| Category | Scale | Severity |
|---|---|---|
| Email addresses | 109 matches / 51 files | high for the real mailbox in `_plan/260730_gui_hydration_loading_unify/001_live_evidence.md` |
| Absolute Unix home paths with a username | 1174 matches / 169 files | medium-high |
| Windows home paths | 16 matches / 6 files | medium |
| Private/internal repository URLs | 15 matches / 7 files | high |
| Loopback/private host references | 492 matches / 192 files | low individually, noisy in aggregate |

## D. Infrastructure state — the category the README already forbids publishing

| Category | Files | Hits |
|---|---:|---:|
| Endpoint URLs | 370 | 1650 |
| Account pools / rotation / affinity | 153 | 426 |
| Account / workspace / tenant identifiers | 117 | 571 |
| Rate-limit / quota / retry behavior | 265 | 1517 |
| Detection / fingerprinting / suspension / ToS reasoning | 186 | 467 |

devlog's own `README.md:10-12` says exactly this material is why the notes live outside
the public tree. Publishing without a decision here would contradict the project's own
stated policy while that policy text is still in the tree.

## E. Reusable scan, for whoever resumes this

Run scoped to the INDEX, not the working tree — the working tree includes gitignored
vendored third-party source and inflates every count:

```bash
cd devlog
git ls-files -z > /tmp/pubset.txt

# fixed-format credentials, redacted output
xargs -0 rg -n -o --pcre2 --replace '<REDACTED:credential>' \
  -e '\bsk-[A-Za-z0-9_-]{20,}\b' \
  -e '\bgh[pousr]_[A-Za-z0-9_]{20,}\b' \
  -e '\bgithub_pat_[A-Za-z0-9_]{20,}\b' \
  -e '\bAKIA[0-9A-Z]{16}\b' \
  -e '\bsk-ant-[A-Za-z0-9_-]{20,}\b' \
  -e '\bAIza[0-9A-Za-z_-]{20,}\b' \
  -e '\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b' \
  -e '-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----' \
  < /tmp/pubset.txt

# personal data, redacted output
xargs -0 rg -n -o --pcre2 --replace '<REDACTED:email>' \
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' < /tmp/pubset.txt
xargs -0 rg -n -o --pcre2 --replace '<REDACTED:home-path>' \
  '/(?:Users|home)/[A-Za-z0-9._-]+/' < /tmp/pubset.txt

# disclosure candidates, review context privately
xargs -0 rg -n -i -e 'advisory|exploit|bypass|unpatched|unfixed|CVE|RCE' \
  -e 'escalation|sandbox escape|auth bypass|SSRF|path traversal' < /tmp/pubset.txt
```

Clean baseline required before any publication: zero fixed-format credential hits, zero
non-placeholder secret assignments, zero personal home paths or real mailboxes, zero
private repository URLs, and zero undisclosed security records.
