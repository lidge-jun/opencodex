# 100 — PR #249: feat: Named Cloudflare Tunnel default public API path

- **Author:** Aiweline
- **Branch:** feature/cloudflare-tunnel → dev
- **CI:** 6/7 checks fail (narrow causes: privacy-scan fixture email + missing i18n keys)
- **Decision:** KEEP OPEN + REQUEST CHANGES (amended from CLOSE per audit)
- **Risk:** High (2268 lines, 20 files, spawns external process)

## Why Keep Open (Audit Amendment)

Per Sol reviewer: the 6 CI failures reduce to two narrow causes, not structural
breakage. Tests otherwise pass. Existing maintainer comment explicitly requests
dedicated security/operations review rather than closure.

## Substantive Concerns (for review comment)

1. **Security:** Spawns `cloudflared` as child process, manages tunnel tokens. Token
   handling needs dedicated security review per MAINTAINERS.md.
2. **Scope:** 2268 lines across 20 files is very large for one PR. Suggest splitting:
   server module first, GUI integration second.
3. **Resource cleanup:** Process lifecycle management (start/stop/crash recovery)
   needs review for edge cases.
4. **CI fixes needed:** privacy-scan fixture email, missing i18n translation keys.

## Action

- Post review comment listing the 4 concerns above.
- Do NOT close. Leave open for author to address.
