# The consequence dialog: design read and exact copy

> **Rev 4** after audit round 4 and the re-scope (`007`). This unit ships ONE
> dialog — Grok's. The Codex and Claude Desktop copy below stays as the design
> of record for `../260803_codex_desktop_toggle/`, which owns those two clients;
> it is not implemented here. Grok's undo paragraph is corrected: re-enabling
> regenerates the fence, it does not restore old bytes.

Design spec. Implementation lives in `040`; this doc owns the direction and the
strings.

## Design Read

```yaml
---
name: opencodex-consequence-dialog
colors:
  primary: "var(--text)"
  accent: "var(--red)"
  background: "var(--raised)"
typography:
  heading: { fontFamily: inherit, fontSize: var(--text-control) }
  body: { fontFamily: inherit, fontSize: var(--text-caption) }
iconography:
  system: "existing gui/src/icons.tsx set"
  weight: "regular"
  domain: "library-subset"
---
```

Reading this as: a destructive-action confirmation inside an operator control
panel, for a developer who already knows what these clients are and needs to
know what breaks. Closer to a package manager's "the following will be removed"
than to a consumer app's "are you sure?" — the value is in the specifics, and
every sentence that is not a specific is noise.

Do's: name the literal path; say what stops working in the user's words, not
ours; state undo honestly including when it is imperfect.
Don'ts: no generic "이 작업은 되돌릴 수 없습니다" boilerplate, no red-splash
alarm styling, no emoji, no motion.

```
DESIGN_VARIANCE: 2
MOTION_INTENSITY: 1
Product density profile: D5
Reasoning: dashboard/admin preset is V3/M2/D5; a destructive confirmation drops
variance one further because ornament competes with the facts the user must read
before deciding.
```

Concept generation (UX-CONCEPT-GEN-01) is **skipped**: utility dashboard surface
under an existing design system, which the skill names as an explicit skip.

## Lazy-user gate (UX-LAZY-01)

Ran the ladder honestly, because a confirmation dialog is exactly the kind of
decision point this gate exists to delete:

1. **Do nothing** — can a default remove the decision? No. The user is asking to
   change state on their own machine; there is no default that does it for them.
2. **Delete** — does it earn its cost? For **Grok, yes**: it edits a file
   another program reads. For **Claude Code, no** — it flips one boolean in our
   own config, breaks nothing on disk, and is undone by flipping it back. A
   confirmation there is pure friction.
3. **Absorb** — can the system take the complexity? Yes, and this is what
   changed after five audits: Grok's undo is the enable path regenerating the
   fence, so the dialog can say what re-enabling does instead of warning the
   user to be careful.
4. **Demote** — the path and the technical detail are the second line, not the
   headline.

**Decision: one dialog, not two.** Claude Code toggles immediately. The
asymmetry is deliberate and the reason is on-disk blast radius, not caution
level. (The sibling unit's Codex and Desktop dialogs follow the same rule and
both earn one.)

## Structure

Four required slots plus one optional, always in this order, because it is the
order the questions occur:

1. **Title** — the action and its target. "Grok Build 연동을 해제할까요?"
2. **What changes** — the literal path and the literal edit.
3. **What stops working** — in the user's terms.
4. **Undo** — honest, including "we cannot restore X".
5. **Side effects** — only rendered when there are any. An always-present empty
   row trains the eye to skip the position.

Confirm button names the action ("해제", "복원") — never "확인". A user who
skims the buttons should still know what they pressed.

## The copy (Korean source; other five locales translate from this)

### Grok Build

> **Grok Build 연동을 해제할까요?**
>
> `~/.grok/config.toml`에서 opencodex가 표시해 둔 블록만 제거합니다. 블록
> 바깥에 직접 쓴 내용은 그대로 둡니다.
>
> 해제하면 Grok Build에서 opencodex 모델 별칭이 사라집니다. xAI 계정으로 쓰던
> 모델은 그대로입니다.
>
> opencodex가 loopback 주소로 실행 중이면, 다시 켤 때 지금 쓸 수 있는 모델
> 목록으로 블록을 새로 씁니다.

No side-effect line: nothing else depends on the fence.

The undo sentence describes what the writer does, and the hedge is INSIDE the
string on purpose (wp4 A-gate M4): under a non-loopback bind enable never
writes a block — it strips a stale one or reports superseded — and
`NativeStatus` carries no bind field for the GUI to branch on, so the
conditional lives in the copy. Earlier revisions promised a file restored from
a snapshot; `012` established that Grok's undo is the enable path, which
regenerates the block from the current catalog — a better outcome than
replaying an hour-old snapshot, but a different promise, and the copy has to
make the one that is true.

### Claude Code — no dialog

Toggles immediately, per the lazy-user gate. If a user turns it off by accident
they turn it back on; nothing on disk moved.

## Refusals are not dialogs

A refusal arrives AFTER the user already confirmed, so it belongs in the card's
notice area, next to the switch that failed — not in a second modal. This unit
produces four, each stating the state and the one thing that would change it:

- **Grok `orphaned-marker`** — "`~/.grok/config.toml`에 opencodex 시작 표시는
  있는데 끝 표시가 없습니다. 어디까지가 우리 블록인지 확신할 수 없어 파일을
  건드리지 않았습니다." No "try again": retrying is exactly what will not help.
- **Home mismatch** — names both recorded and current homes. Do NOT say "stop
  the service": the trigger is a home mismatch, not a running service (`001`
  §The guard I described wrong).
- **`not_installed`** — Grok is not installed; the card reads not-installed and
  the switch does not offer an action there is nothing to perform.
- **`config_busy`** — "다른 곳에서 설정을 저장하는 중이라 변경하지 못했습니다.
  잠시 후 다시 시도해 주세요." The ONLY refusal here where retrying is the right
  advice, because the lock is held right now and will be released. Every other
  one describes a condition retrying cannot change. It fires only for genuine
  contention (`cause.code === "SQLITE_BUSY"`); a lock that cannot be opened at
  all is a `write_failed` failure, not a wait (`030` §Lock contention).

That is the complete list of REFUSALS the user is shown as an explained state.
It is not the complete list of ways a request can fail: `write_failed` remains
a 500 failure envelope with the server's own message (`030`). The sibling unit's
refusals are specified in the appendix and must not be added here. There is no
`partial` either — neither of this unit's clients can half-apply.

TWO outcomes are NOT refusals and must not be styled as ones. Both come from
enabling Grok under a non-loopback bind, and which one fires is decided by
reading the file after the write (`012` §The fix), never by what the request
intended.

**`non_loopback_removed`** — the normal case. The block is gone. The copy
branches on `changed` (wp4 A-gate M6): the payload's `changed` comes from the
strip itself, so with no prior block the "removed" sentence would be a lie.

`changed: true`:

> Grok Build은 opencodex가 loopback 주소로 실행 중일 때만 자동 등록할 수
> 있습니다. loopback 주소를 가리키던 이전 블록은 제거했습니다.

`changed: false`:

> Grok Build은 opencodex가 loopback 주소로 실행 중일 때만 자동 등록할 수
> 있습니다. 제거할 이전 블록은 없었습니다.

**`non_loopback_superseded`** — rare. Between our removal and our read, something
else wrote a well-formed block into the file: `ocx ensure`, a second proxy, or
the user's own edit.

> Grok Build은 opencodex가 loopback 주소로 실행 중일 때만 자동 등록할 수
> 있습니다. 그 사이 다른 곳에서 설정에 블록이 새로 쓰여, 지금 파일에 있는
> 블록은 이 요청이 만든 것이 아닙니다.

The second sentence is the whole point: the card will show 연결됨 for a block
this request did not write, and a user who is not told that would reasonably
conclude the toggle worked as asked. Saying so costs one sentence and prevents a
wrong mental model of who owns that file.

Neither is a refusal, so neither goes in the notice area's error styling — they
are success messages with a caveat, rendered in the card's normal message slot.

The older wording below describes `non_loopback_removed` only and is kept for
its rationale: enabling Grok under a non-loopback bind removes any stale
generated block and reports success with `changed: true`
(`012` §non-loopback is not a refusal). The copy says what happened —
"loopback 주소를 가리키던 이전 블록을 제거했습니다" — rather than implying the
request was declined.

## Verification

A dialog is a render artifact, so C runs the render-grounding loop
(C-RENDER-GROUNDING-01): open Grok's dialog in the real browser, screenshot,
read the screenshot back, and assert the rendered text — not just that a modal
with the right test id mounted.


---

## Appendix — Codex and Claude Desktop copy (NOT this unit)

These two clients moved to `../260803_codex_desktop_toggle/` (`007`). The copy
below is their design of record and is **not implemented here** — WP4 ships one
dialog, Grok's. It lives in this file because the direction, the four-slot
structure and the refusal vocabulary are shared, and splitting the copy from the
design that produced it is how the two drift apart.

Audit round 5 flagged the previous arrangement: these sections read as
executable contracts for this unit. The heading above is the fix.

### Codex

> **Codex 연동을 해제할까요?**
>
> `~/.codex/config.toml`과 `~/.codex/opencodex.config.toml`에서 opencodex가 쓴
> 부분을 제거하고, 모델 카탈로그를 백업본으로 되돌립니다.
>
> 해제하면 `codex`가 프록시를 거치지 않고 OpenAI로 직접 붙습니다. opencodex에
> 연결한 다른 제공자 모델은 Codex에서 사라집니다.
>
> 되돌릴 수 있습니다. 해제 전 라우팅 상태를 기록해 두고, 복원하면 적용할 때와
> 같은 경로로 다시 설정합니다. 대화 기록의 제공자 표시도 함께 맞춥니다.
>
> 이미 실행 중인 Codex 세션은 바로 바뀌지 않을 수 있습니다. 새로 시작하세요.

The undo paragraph describes a STATE being re-established, not files being put
back, because that is what `013` actually does. Two earlier drafts got this
wrong in opposite directions: rev 1 pointed at
`~/.codex/opencodex-journal.json`, a file `restoreNativeCodex` deletes on a
complete restore, so the promise expired exactly when it was needed; rev 2
listed three restored artifacts and excluded history, which the audit read as
leaving threads tagged native beside proxy-routed config. History is now
re-synced in the matching direction, so the copy can include it.

That last line is load-bearing: `app-server-processes.ts:546` proves a long-lived
app-server holds state in memory, and nothing proves it re-reads
`openai_base_url`. Promising an instant switch would be a lie we can't back.

### Claude Desktop

> **Claude Desktop 연동을 해제할까요?**
>
> `<configLibrary>/<id>.json`을 지우고 `_meta.json`의 opencodex 항목을
> 제거합니다. Desktop이 이 프로필을 쓰고 있었다면 남아 있는 다른 프로필로
> 넘깁니다.
>
> 해제하면 Claude Desktop에서 opencodex로 연결한 모델을 더는 쓸 수 없습니다.
>
> 되돌릴 수 있습니다. 프로필과 `_meta.json`을 함께 보관하므로, 복원하면
> Desktop이 쓰던 프로필 선택까지 그대로 돌아옵니다. opencodex 쪽 설정은 그
> 항목만 되돌리므로, 그 사이에 바꾼 다른 설정은 그대로 유지됩니다.

Desktop is the one client whose undo has to describe two mechanisms, so the copy
does (`014` §Two mechanisms, one operation): the library comes back as bytes —
which is what returns the previous `appliedId` — while opencodex's own settings
come back field by field. The second sentence exists because a user who changed
providers after disabling must not fear that undo reverts that too.

Rev 1 said we could not know the previous profile at all. That was true only of
a design that snapshotted `_meta.json` without the profile beside it, and it is
the clearest evidence the first audit was right.

The `no_safe_desktop_fallback` case never reaches this dialog: it is refused at
preflight, before the user is asked to confirm anything.

The last paragraph is the honest cost of a gap in the original design: apply
overwrote `appliedId` without recording what was there. We say so rather than
silently picking one and letting the user discover it.
