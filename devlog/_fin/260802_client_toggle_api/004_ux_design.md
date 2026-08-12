# 004 — UX design: unified Integrations surface

Design spec only. Component diffs belong to a later implementation cycle.
Grounds every choice in the existing GUI (read this cycle): sidebar `NAV` in
[App.tsx:50-63](/Users/jun/Developer/new/700_projects/opencodex/gui/src/App.tsx:50),
the sub-tab pattern shared by Logs (`#logs/debug`, hash-routed, lazy-mounted,
poll-gated) and Claude (`code/desktop` segmented strip with arrow-key nav and
`preventScroll` focus), the sidebar inline `Switch` precedent on the Claude
nav entry, `Switch` in [ui.tsx:8](/Users/jun/Developer/new/700_projects/opencodex/gui/src/ui.tsx:8),
`CLIENT_MARKS` (real favicon or monogram tile, never a borrowed logo), and the
CSS token base (`--accent`, `--green/--amber` + `-soft` pairs, `--border`,
`--font-ui/--font-code`, control sizes in `gui/src/styles.css:25`).

## 1. Design Read

```yaml
---
name: opencodex-gui-integrations
colors:
  primary: "inherit: --fg/--bg token pair (theme-aware)"
  accent: "inherit: --accent + --accent-soft (existing GUI accent)"
  background: "inherit: --bg, --glass-panel for the hero strip"
typography:
  heading: { fontFamily: "var(--font-ui)", fontSize: "page-head scale (existing)" }
  body: { fontFamily: "var(--font-ui)", fontSize: "body scale (existing)" }
iconography:
  system: "existing gui/src/icons.tsx set"
  weight: "match current stroke weight"
  domain: "CLIENT_MARKS precedent — real client favicon or monogram tile"
---
```

Reading this as: a dense operator surface for a developer proxy dashboard,
with a control-room language. One glance must answer "what is connected, what
is applied, and can I undo it" — closer to an audio patchbay than to a
marketing integrations gallery.

Do's: compose the sub-tab mechanics from their proven parts — Logs hash
ownership + existing wrapping tab CSS + Claude focus behavior (§3.2); make
rollback the most visible safety promise; keep every client honest about its
real state (including "we cannot tell").
Don'ts: no marketing-hero treatment, no celebration motion on toggles, no
boolean-looking UI over a five-state backend, no per-client visual
re-theming.

### Dial setting

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 2
Product density profile: D6 (dense admin / repeated ops work)
Reasoning: developer ops dashboard where toggling is repeated work; trust
comes from state honesty and undo, not from visual novelty. Domain gate:
dashboards never receive the expressive kit by default.
```

Concept generation (UX-CONCEPT-GEN-01): SKIPPED — utility CRUD/dashboard
surface inside an existing design system; no new brand-visible composition.

## 2. Tab name: **Integrations**

Recommendation: rename the `api` sidebar entry to **Integrations** (i18n key
`nav.api` -> `nav.integrations`; ko "연동", en "Integrations", other locales
follow their usual SaaS wording).

| Candidate | Verdict | Why |
|-----------|---------|-----|
| **Integrations** | Recommended | The surface covers three things — proxy credentials (API keys), downstream client installs, and apply/rollback state. "Integrations" is the only word that covers all three; it is also the word users already know from every SaaS settings page. |
| Clients | Rejected | Accurate for the export clients, but the tab also owns API keys (proxy-side credentials), which are not clients. Also invites confusion with upstream "providers". |
| Connections | Rejected | Reads as network/transport state in a proxy product — collided vocabulary. |
| API (current) | Rejected | Names only the keys half; the switch surface would live under a label that undersells it. |

Sidebar change: the `api`, `claude`, and `grok` entries collapse into one
`integrations` entry (11 -> 9 nav items). The inline `Switch` on the Claude
nav entry moves into the Claude sub-tab header — the sidebar returns to
navigation-only, which also removes the oddity of a switch that controls
something invisible until you open the page.

## 3. Information architecture

Hash-routed sub-tabs, reusing the Logs pattern (`readTabFromHash`, lazy mount,
`active`-gated polls, `role="tablist"` + arrow keys):

```
Integrations
├─ #integrations                 Overview (hero: detection + switches + rollback center)
├─ #integrations/keys            API Keys (existing ApiKeysWorkspace panels)
├─ #integrations/codex           Codex CLI (informational card — service-coupled, §5.3)
├─ #integrations/claude          Claude Code (today's ClaudeCode page)
├─ #integrations/claude/desktop  Claude Desktop (today's ClaudeDesktop page)
├─ #integrations/grok            Grok Build (existing Grok page moves in)
├─ #integrations/opencode        OpenCode
├─ #integrations/pi              Pi
├─ #integrations/hermes          Hermes Agent
├─ #integrations/openclaw        OpenClaw
├─ #integrations/kimi            Kimi Code
└─ #integrations/gajae           Gajae Code
```

Claude Code and Claude Desktop are **separate integration surfaces** — they
have independent backends, and only Claude Code has an enable switch (the
sidebar Switch drives `/api/claude-code`; Desktop works through its own
Save/Apply + fingerprint status) — joined under one family tab with the
existing Code | Desktop segmented strip; the nested hash gives Desktop its
own deep link for the first time.

### 3.1 Routing contract (A-gate amendment)

- `integrations` and every suffix above must be registered in
  `app-routing.ts` normalization — unregistered suffixes do not survive it,
  so this is a hard prerequisite, not a detail.
- Legacy redirects, applied once via `replaceState` (no history spam):
  `#api` -> `#integrations/keys`, `#claude` -> `#integrations/claude`,
  `#grok` -> `#integrations/grok`.
- An unknown `#integrations/<suffix>` lands on Overview with a `replaceState`
  correction, matching how unknown hashes degrade today.
- Back/Forward: the hash is the source of truth for the active tab (Logs
  precedent), so browser navigation walks tab history.

### 3.2 Tab strip overflow (A-gate amendment)

Eleven tabs exceed one row on narrow windows. The existing `.page-tabs`
**wraps** to multiple rows and has no horizontal-scrollbar mechanics, and the
Logs keyboard path does not scroll. The design therefore keeps wrapping —
not a scrolling strip: wrapped tabs stay on-screen, so keyboard focus can
never land on an off-screen tab, and no new scroll/focus contract is needed.
Focus behavior on tab change follows the Claude strip (`preventScroll`), not
the Logs strip. Tab order is stable — never reordered by detection state —
because muscle memory beats proximity on a repeated-work surface; undetected
clients keep their tab with a "미설치" dot and the not-installed empty state
(§8), the deliberate alternative to hide-if-absent tabs that would make the
strip jump as clients come and go.

The per-client export panel currently inside `ClientConfigPanel` leaves the
keys tab and lands inside each **file-toggle** client tab (§5.4; capability
matrix in §5.0 names which clients have an export surface at all) — keys tab
keeps credentials and endpoints only.

## 4. Overview (the hero)

Not a marketing hero — an ops summary strip plus a detection grid. Three
zones, top to bottom:

**4.1 Summary strip.** One line of counts: `7개 감지됨 · 3개 적용 중 · 1개
업데이트 필요 · 마지막 변경 12분 전`. On the right, one quiet text action
`모두 해제…` — scoped to the file-toggle clients (§5.0; the exception
clients' own controls are untouched) — which opens a confirm dialog listing
exactly which clients will be disabled and what happens to each
(destructive-adjacent, so it keeps its confirmation per the lazy-gate
exemption). There is deliberately no "모두 적용": enabling has per-client
preconditions (install detection, conflict resolution), so a bulk-enable
button would only ever half-work.

**4.2 Client card grid.** One card per client, in the same stable order as
the tab strip. Cards are **capability-aware** (§5.0): the switch, five-state
badge, and backup line render only on file-toggle client cards — the four
exception clients render their own native status and action instead (Claude
Code: its enable flag switch; Claude Desktop: Save/Apply + fingerprint
status; Grok: select/save/apply state; Codex: informational service link).
A file-toggle card:

```
┌─────────────────────────────────────┐
│ [mark]  Hermes Agent        [badge] │
│ 설치 감지됨 · v1.2.3                │
│ ~/.hermes/config.yaml               │
│                          [switch]   │
│ 적용됨 · 14:32 · 백업 보관됨        │
│ 설정 →                              │
└─────────────────────────────────────┘
```

- Brand mark per `CLIENT_MARKS` precedent (real favicon asset or monogram
  tile; never another product's logo).
- Detection line: installed/not, version when the client exposes one, config
  path in `--font-code`.
- Switch with the five-state badge next to it (§7), on file-toggle cards —
  the badge is always present, so the switch never has to carry state it
  cannot express. Exception cards show their §5.0-native status in the same
  slot, so the grid stays visually aligned without faking a switch.
- Bottom line: last-applied time + backup presence (file-toggle cards; the
  exception clients show their native equivalent, e.g. Desktop's
  saved-vs-applied fingerprint line). This line is the rollback promise made
  visible at all times, not hidden in a dialog.
- `설정 →` deep-links to the client's sub-tab (hash).

**4.3 Rollback center.** A compact log of recent apply/disable/restore
operations from the **file-toggle clients' operation journal** (§6.1; the
four exception clients keep their state in their own surfaces and do not
write journal rows) — newest first, ~5 rows: `14:32 Hermes 적용 — 되돌리기` /
`14:10 OpenClaw 해제 — 이 시점으로 복원…` / `어제 Kimi 복원 완료`. Row
actions follow §6.1 exactly: `되돌리기` only on each client's newest
operation, `이 시점으로 복원…` on older rows whose snapshot survives, and a
disabled `백업 만료됨` on rows whose snapshot was collected — the row stays
as a record, the action does not pretend to exist. Empty state: `아직 적용
기록이 없습니다` plus one line explaining that every apply keeps a backup —
the feature's elevator pitch told when there is nothing to show.

## 5. Client sub-page anatomy

### 5.0 Capability matrix (A-gate amendment)

The clients do not share one contract, so the page skeleton below applies
**only where the capability row says it does**. This matrix, not the
skeleton, is the per-client source of truth:

| Client | Detection | State model | Switch means | Apply mechanism | Restore | Export |
|--------|-----------|-------------|--------------|-----------------|---------|--------|
| Codex CLI | service liveness | service states (running/stopped) | **none — informational card** linking to service controls | service-coupled injection (`ocx start`/`stop`) | service stop restores | n/a |
| Claude Code | `~/.claude` presence | proxy-side enabled flag + auth mode | opencodex-side enable (`/api/claude-code`) | existing PUT; launcher env for the client | n/a (flag flip) | n/a |
| Claude Desktop | config library path | saved/applied fingerprint (today's status route) | apply/stop-serving semantics | `POST /api/claude-desktop/apply` | profile swap-back | n/a |
| Grok Build | `~/.grok` presence | status reader (present/baseUrl/models) + policy skips | **no binary switch** — keeps its select/save/apply flow | `POST /api/grok/apply` | strip path (`ocx stop`) | n/a |
| OpenCode | binary + XDG config dir | five-state (003 §3) | file toggle | file writer (003) — launcher precedence caveat (003 §4) | snapshot restore | existing export |
| Pi | binary + `~/.pi` | five-state | file toggle | file writer | snapshot restore | existing export |
| Hermes | binary + `~/.hermes` | five-state | file toggle | file writer (YAML) | snapshot restore | proposed — new export contract required |
| OpenClaw | binary + `~/.openclaw` | five-state | file toggle | `openclaw config set/unset` CLI preferred | snapshot restore | proposed — new export contract required |
| Kimi Code | binary + `~/.kimi-code` | five-state | registry add/remove | `kimi provider add/remove` + served `api.json` | snapshot restore | proposed — new export contract required |
| Gajae Code | binary + `~/.gjc` | five-state | file toggle | `gjc setup provider` add + file-writer remove | snapshot restore | proposed — new export contract required |

Consequences: the five-state badge, the switch, and the snapshot-rollback
chrome (§5.1-5.2, §6) render only for the six file-toggle clients (OpenCode,
Pi, Hermes, OpenClaw, Kimi, Gajae). Codex, Claude Code, Claude Desktop, and
Grok keep their own truth — the design unifies their *placement*, not their
semantics.

### 5.1 Header

Mark + name, the state badge, the switch (primary action, file-toggle clients
only), and a secondary `백업에서 복원…` button. Restore is **offered in every
state where a snapshot exists — including `conflict` and `unsafe`**, where
the switch itself is locked; its preflight (§6) then decides between a clean
restore, a drift-confirmed restore, or a refusal with manual instructions.
"Rollback is always reachable" is the promise; "restore never needs
judgment" is not — see §6.

### 5.2 Status line

`적용 14:32 · 백업 14:32 · 마지막 복원 없음` — three facts, code font, no
color unless something needs attention.

### 5.3 Apply semantics note (per client, one line)

What "applied" means for this client, from 002: OpenClaw — `실행 중인
게이트웨이에 즉시 반영됩니다`; Hermes — `새 세션부터 적용됩니다`; Gajae —
`새 세션 또는 /model을 열 때 적용됩니다`; Kimi — `재시작 또는 /reload 시
적용됩니다 (v2는 파일 변경을 감지합니다)`; Codex — special: this tab is an
informational card, not a switch — it explains that Codex wiring is owned by
the proxy service (`ocx start` injects, `ocx stop` restores) and links to the
service controls. A per-client switch that secretly restarted the whole
proxy would be a bigger hammer than the card promises.

**5.4 Settings.** Per-client knobs, each behind the same apply button so
settings + switch ride one write path:

- Exposed models: multi-select from the proxy catalog (defaults to all
  visible; this is the toggle-time model list of 003).
- Default-model pointer where the client has one (OpenClaw
  `agents.defaults.model.primary`, Kimi `default_model`, Hermes
  `model.default`) with an explicit `건드리지 않음` option as the default —
  the toggle must not silently hijack the user's default.
- Credential env var name (read-only display of the referenced var, e.g.
  `OPENCODEX_API_KEY`) + the existing export/download affordance from
  `ClientConfigDialog`.
- Advanced (collapsed): raw config preview with our block highlighted,
  ownership/fingerprint details, config path.

**5.5 Apply history.** Per-client mini log, same row shape as the rollback
center.

## 6. Rollback UX — the guarantee, designed

The pitch is "스위치로 뺐다 넣었다 항상 원복" — so rollback is designed as
two recovery levels plus a strict preflight contract, not one button and not
overlapping ones (A-gate amendment: switch-off/`해제` IS the owned-block
removal of 003 §3 — one backend operation, one label; it is not also a
"rollback level"):

| Level | Surface | Mechanism | When it exists |
|-----|---------|-----------|----------------|
| 1. 되돌리기 (undo) | Toast after a successful apply/disable/refresh + the latest row per client in the rollback center | restores that operation's own pre-write snapshot | the client's **latest** operation only, while its snapshot is retained |
| 2. 복원 (restore) | `백업에서 복원…` in the client header + any rollback-center row | writes a chosen snapshot back wholesale, after the preflight below | whenever that snapshot exists — offered in **any** state, including `conflict`/`unsafe` |

Vocabulary, fixed: `적용` = switch on (writes our block); `해제` = switch off
(removes exactly our owned block — the 003 disable); `되돌리기` = undo one
operation; `복원` = full-file restore from a snapshot. No fifth verb.

### 6.1 Operation journal and snapshot identity (A-gate amendment)

- Every write operation (apply/disable/refresh/restore) gets an immutable
  operation id and its **own** snapshot of the pre-write file, stored per
  client (e.g. `<config>.ocx-backups/<opId>`); a single shared `.bak`
  overwrite (the Claude Desktop precedent) cannot honor per-operation undo
  and is explicitly not the model here.
- Retention: keep the latest **10** snapshots per client; older ones are
  garbage-collected. A history row whose snapshot was collected renders
  disabled with `백업 만료됨` — the row stays as a record, the action does
  not pretend to exist.
- Undo binds strictly: only the client's newest operation offers
  `되돌리기`, and only while the file still matches that operation's
  post-write state (otherwise the row degrades to a restore offer). Older
  rows offer `이 시점으로 복원…`, which is level 2 with the preflight below —
  never a silent multi-step rewind.

### 6.2 Restore preflight (A-gate amendment)

"복원" being always offered does not mean it always writes. Before anything
is committed:

1. **Snapshot the current file first.** Every restore begins by taking a new
   snapshot of the file as it exists right now, so a restore is itself
   undoable. Rollback can never strand the user.
2. **Drift check.** If the current file still equals the state that snapshot
   was taken to protect against (no post-snapshot edits), restore proceeds
   with a plain confirm. If the file has drifted — the user or the client
   edited it after the snapshot — the dialog says so and names the
   consequence (`스냅샷 이후의 변경이 백업으로 보관되고 파일이 교체됩니다`),
   requiring an explicit confirm. Newer edits are preserved by step 1's
   backup, never silently destroyed.
3. **Refusal path.** If the target path is not a regular writable file
   (symlink, directory, missing parent, permission failure), restore refuses
   and the Notice names both the snapshot path on disk and the reason, so the
   user can finish the job by hand. A rollback feature that dead-ends
   silently is worse than none — but one that writes somewhere it must not
   is worse still.

Supporting rules surfaced as UI copy, not buried in docs:

- Every apply writes a backup first (`백업 보관됨` is a first-class status
  fact on cards and headers).
- We only ever remove what we wrote; the `conflict` state exists to prove we
  mean it — the switch locks, the dialog shows the drift, and the offered
  actions are `복원` / `내용 확인 후 인계` (explicit takeover) / `그대로 두기`.
- `해제` (switch off) is surgical — it removes exactly our owned block and
  says so; `복원` is a full-file rollback and says so in its confirm. The
  two are never merged into one ambiguous "초기화".

## 7. State model → visual mapping

Backend states (003 §3) plus detection, mapped one-to-one onto visuals — the
switch shows on/off, the badge shows truth:

| State | Badge (tone) | Switch | Primary actions |
|-------|--------------|--------|-----------------|
| 미설치 | `미설치` (faint) | disabled | install-guide link; tab shows empty state |
| 미적용 (`absent`) | `미적용` (faint) | off | apply |
| 적용됨 (`current`) | `적용됨` (green) | on | disable (`해제`), restore |
| 업데이트 필요 (`stale`) | `업데이트 필요` (amber) | on | refresh (re-apply), disable, restore |
| 충돌 (`conflict`) | `충돌` (red) | **locked** | restore (§6.2 preflight), takeover dialog |
| 확인 불가 (`unsafe`) | `확인 불가` (red, outline) | **locked** | restore (§6.2 preflight), open config path |

Tones ride existing tokens (`--green`/`--amber`/`--accent` + `-soft` pairs);
no new hues. Every async action (detection scan, apply, restore) drives the
existing `Notice` + busy/disabled semantics; polls stay `active`-gated per
tab as in Logs.

## 8. UX states

- **Loading**: first detection scan shows skeleton cards in the known grid
  structure (known-structure rule); subsequent refreshes keep the grid and
  mark only stale rows.
- **Empty**: no clients detected at all -> hero shows one line
  (`설치된 클라이언트가 감지되지 않았습니다`) + install links for the
  supported set, and the rollback center shows its own empty line. The page
  never renders a bare grid.
- **Error**: detection/status poll failure keeps the last good grid, adds the
  Logs-precedent stale callout with retry; an apply/restore failure uses the
  `Notice` error path with the backup path named (§6).
- **Onboarding**: first visit (no apply history anywhere) pins one
  explanation line under the summary strip — what "적용" does (writes one
  provider block into the client's config), and the safety promise (backup
  first, remove only ours, restore anytime). It dismisses permanently after
  the first successful apply.

## 9. Lazy-gate audit (decision points justified)

| Decision point | Disposition |
|----------------|-------------|
| Per-toggle confirm on enable | **Deleted** — undo toast (level 1) carries reversibility; a confirm on a fully reversible action is pure cost |
| Confirm on `모두 해제` | Kept — bulk + destructive-adjacent (exemption class) |
| Confirm on restore / takeover | Kept — full-file overwrite / foreign-block ownership change (exemption class) |
| Default-model pointer per client | Demoted — defaults to `건드리지 않음`; system absorbs the safe choice |
| Raw config preview / fingerprint details | Demoted — collapsed "고급" section |
| `모두 적용` bulk enable | **Deleted** — preconditions differ per client; the button could never mean what it says |

One primary action per client surface: the switch on file-toggle clients
(§5.0), the existing primary flow on the four exception clients. Everything
else is secondary or collapsed.

## 10. Accessibility and keyboard

- Tab strip: `role="tablist"`, `aria-selected`, ArrowLeft/Right + Home/End,
  `focus({ preventScroll: true })` — the Claude strip's focus behavior (the
  Logs strip does not scroll or `preventScroll`; §3.2 picked wrapping, so no
  tab can focus off-screen).
- Switch: existing `Switch` component (`aria-pressed`, `aria-label`).
- Locked switches (conflict/unsafe) are `disabled` + `aria-describedby`
  pointing at the badge text, so the lock explains itself. Implementation
  note: today's `Switch` accepts no `aria-describedby`/extra props — this
  requires a small component-contract extension, flagged here so the
  implementation cycle prices it.
- Apply/restore outcomes announce through `Notice` (`role="status"`).

## 11. Migration map (existing surfaces -> new home)

| Today | Becomes |
|-------|---------|
| sidebar `api` (ApiKeys page) | `#integrations/keys` minus the client-config panel |
| sidebar `claude` (Claude hub: Code/Desktop) | `#integrations/claude`, composition unchanged |
| sidebar `grok` (Grok page) | `#integrations/grok`, content unchanged — retains its select/save/apply flow; **no** integration switch or snapshot-rollback chrome (§5.0) |
| sidebar Claude inline Switch | Claude **Code** header switch specifically (it drives `/api/claude-code` only; Desktop has no such switch) |
| `ClientConfigPanel` per-client rows | export/settings section inside the OpenCode and Pi tabs only, until new export contracts exist for the other clients (§5.0) |
| ClaudeDesktop apply/status machinery | **visual** precedent for the file-toggle tabs' status chrome (§5.1-5.2) — semantics follow §5.0 per client, never copied wholesale |

## 12. Non-goals and open questions

Non-goals: no redesign of the sidebar shell, theme system, or other pages; no
new color tokens; no concept-image exploration (§1); no per-client branding
beyond marks; no implementation (component diffs are the next cycle's decade
docs).

Open questions for the implementation cycle:

1. Detection contract per client (binary on PATH? config dir existence?
   version probe) — needs the same source-level rigor as 002, per client.
2. Where apply history persists (opencodex config vs a small journal file)
   and its rotation bound.
3. i18n: six locales need the new `nav.integrations` + state-badge strings;
   Korean copy above is the source of truth for tone.

Resolved during A-gate (no longer open): the Codex tab is an informational
card with no switch (§5.0, §5.3); snapshot retention is count-based at 10
per client (§6.1).
