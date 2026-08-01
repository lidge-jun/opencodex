# 080 — WP8: usage surface taxonomy + Grok tag (D3)

Root cause in `030a_defect_investigation.md` §D3 (three audit rounds folded). This doc
is the implementation contract.

## Scope

IN: fix the codex bucket swallowing `claude-desktop`; widen the surface union with
`grok`; update BOTH serializers + `parseUsageSurface`; emit `x-opencodex-grok` from the
fence and read it in `handleChatCompletions`; add the grok filter tag + icon.
OUT: retroactive relabel of historical entries; any use of the attribution for auth or
billing (it is a dashboard tag only).

## The taxonomy, fixed

Current (`src/usage/summary.ts:494-495`): `claude` = `surface === "claude" ||
"claude-desktop"`; `codex` = `surface !== "claude"` — which matches claude-desktop in
BOTH filters and puts every unlabelled request (including Grok) into codex.

New rule: the labelled surfaces are `claude`, `claude-desktop`, `grok`. Everything
unlabelled is the legacy Codex CLI/App bucket. Disjoint predicates:

```ts
if (surface === "claude") return entry.surface === "claude" || entry.surface === "claude-desktop";
if (surface === "grok") return entry.surface === "grok";
// codex = the historical unlabelled bucket: Codex CLI/App turns carry no surface tag,
// and pre-grok entries keep reading as codex. No retroactive relabel.
if (surface === "codex") return entry.surface === undefined;
```

## MODIFY map

### 1. Type unions

`src/usage/log.ts:39` `PersistedUsageEntry.surface` and
`src/server/request-log.ts:36` (`RequestLogContext`) / `:84` (`RequestLogEntry`):

```diff
-  surface?: "claude" | "claude-desktop";
+  surface?: "claude" | "claude-desktop" | "grok";
```

`src/usage/summary.ts:8` `UsageSurface` and the GUI-side type
`gui/src/pages/Usage.tsx:9`:

```diff
-export type UsageSurface = "all" | "codex" | "claude";
+export type UsageSurface = "all" | "codex" | "claude" | "grok";
```

### 2. Serializers — the drop sites (WP5 blocker 2)

`src/usage/log.ts:220`, `src/server/request-log.ts:147`, `:223`: the whitelist
`entry.surface === "claude" || entry.surface === "claude-desktop"` drops any new value
at write time. Replace all three with a truthy spread — the type union is the real
constraint, and a whitelist is exactly what silently loses a new surface:

```diff
-    ...(entry.surface === "claude" || entry.surface === "claude-desktop" ? { surface: entry.surface } : {}),
+    // The union type is the constraint; a literal whitelist is what silently dropped
+    // every new surface at write time.
+    ...(entry.surface ? { surface: entry.surface } : {}),
```

`src/server/request-log.ts:584` already spreads `logCtx.surface` truthily — no change.

### 3. `parseUsageSurface` (`src/usage/summary.ts:100`)

```diff
-  if (input === "codex" || input === "claude") return input;
+  if (input === "codex" || input === "claude" || input === "grok") return input;
```

### 4. The fence emits the tag (WP5 blocker 3 — capability verified)

`src/grok/inject.ts` `buildGrokManagedBlock` gains one line per model, using the Grok
`extra_headers` field the upstream docs say is sent verbatim on inference calls:

```diff
     lines.push(
       ...(isFirst ? [] : [""]),
       `[model.${alias}]`,
       `model = ${tomlString(model.id)}`,
       `base_url = ${tomlString(baseUrl)}`,
       'api_backend = "chat_completions"',
       'api_key = "opencodex-loopback"',
       `name = ${tomlString(model.name ?? `OCX ${model.id}`)}`,
+      // Best-effort attribution tag for the usage dashboard (upstream Grok sends
+      // extra_headers verbatim on inference calls; 11-custom-models.md). This is NOT
+      // a security boundary — any loopback client could send it.
+      'extra_headers = { "x-opencodex-grok" = "1" }',
     );
```

### 5. `handleChatCompletions` reads it (`src/server/chat-completions.ts`)

Near the top of the handler:

```ts
// Best-effort Grok attribution: the managed fence stamps this header on every model it
// registers. Dashboard bucketing only — never an auth or billing signal.
if (req.headers.get("x-opencodex-grok") === "1") logCtx.surface = "grok";
```

### 6. Usage filter tag (`gui/src/pages/Usage.tsx:209-227`)

```diff
-        {(["all", "codex", "claude"] as UsageSurface[]).map(choice => {
+        {(["all", "codex", "claude", "grok"] as UsageSurface[]).map(choice => {
```

```diff
              {choice === "claude" && (
                <img className="usage-source-mark" src="/provider-icons/claude.svg" alt="" aria-hidden="true" />
              )}
+             {choice === "grok" && (
+               <img className="usage-source-mark" src="/provider-icons/grok.svg" alt="" aria-hidden="true" />
+             )}
```

### 7. Locale keys — NEW (all six)

| Key | en | ko | ja | zh | de | ru |
|-----|----|----|----|----|----|----|
| `logs.filter.surface.grok` | `Grok` | `Grok` | `Grok` | `Grok` | `Grok` | `Grok` |

## TESTS

`tests/usage-surfaces.test.ts` (NEW):

- bucketing is disjoint: a `claude-desktop` entry appears in `claude` but NOT in
  `codex`; a `grok` entry appears only in `grok`; an unlabelled entry appears only in
  `codex`; all entries appear in `all`;
- `parseUsageSurface("grok")` returns `grok`, unknown values still fall back to `all`;
- the usage serializer round-trips `surface: "grok"` (the drop-site regression).

`tests/grok-attribution.test.ts` (NEW):

- the emitted fence contains `extra_headers = { "x-opencodex-grok" = "1" }`;
- a chat/completions request carrying `x-opencodex-grok: 1` is logged with
  `surface: "grok"` (drives the header path — activation evidence);
- a request WITHOUT the header keeps `surface: undefined` (codex bucket).

`gui/tests/usage-grok-filter.test.ts` (NEW, source-level like grok-page.test.ts):

- Usage.tsx includes `grok` in the filter array and renders the grok icon;
- `logs.filter.surface.grok` resolves in all six locales.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/usage-surfaces.test.ts tests/grok-attribution.test.ts` | pass |
| `cd gui && bun test tests/usage-grok-filter.test.ts` | pass |
| `bun test tests/grok-config-inject.test.ts tests/grok-sync.test.ts` | existing inject suites still green with the new line |
| full gates | green |
