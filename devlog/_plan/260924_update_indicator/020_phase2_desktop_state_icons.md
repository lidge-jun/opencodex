# Commit 2 — desktop snapshot and tray update dot

Goal: make the Tauri updater the authority for a desktop-only badge and put its pending-update blue dot on each available native tray. This is work-phase wp2, ordered after commit 1 (the package badge/cache contract in 010_phase1_package_cache.md) and before commit 3 (the app-origin install page). The branch carries the four commits in 000_plan.md; this commit is not a separately releasable desktop update flow.

**IN:** bounded admin-token-only POST; process-local session snapshot; desktop badge projection; 60-second native heartbeat; embedded dashboard session URL and GUI poll; macOS AppKit dot; generated dotted Windows/Linux Tauri PNG; focused Bun, Rust, and icon tests; structure and user docs. **OUT:** package cache logic owned by commit 1, install page/IPC and click routing owned by commit 3, npm PowerShell tray owned by commit 4, Windows glyph redesign, persistence, automatic install, signature policy changes, and Lab-boundary imports.

This document specifies the diff to apply in B. All paths are repository-relative. Existing symbol anchors were checked against HEAD b429895f4a: the raw-token principal is assigned in src/server/management-auth.ts:541-564 and exposed in src/server/management/context.ts:136-151; route dispatch and origin/body gates are src/server/management-api.ts:187-205,276-306; the current badge route is src/server/management/sidebar-routes.ts:100-103 and registry row is src/server/management/route-registry.ts:350-353; package badge shape is src/update/badge.ts:6-67. On desktop, the bound credential gate is desktop/src-tauri/src/proxy.rs:181-228, updater transitions are desktop/src-tauri/src/updater.rs:81-114, tray transitions are desktop/src-tauri/src/tray.rs:198-222,284-325, dashboard construction is desktop/src-tauri/src/startup.rs:1407-1438, and the existing NSStatusItem borrow is desktop/src-tauri/src/native_tray.rs:58-75. The Swift status-button lookup is app/Sources/NativeTray/Popover.swift:24-32. These anchors name APIs that exist; the new symbols below are additions.

Additional existing-symbol anchors used in patches: jsonResponse is src/server/auth-cors.ts:267; defaultUpdateTag is src/update/index.ts:176-178; detectInstall/Channel are src/update/index.ts:61-67; useKeyedClientResource is gui/src/client-resource.ts:616; the present sidebar poll is gui/src/components/sidebar-github-row.tsx:67-76; desktop-shell detection is gui/src/lib/desktop-shell.ts:7-13; the Tauri user agent is desktop/src-tauri/src/window.rs:4-14; app.package_info() is used at desktop/src-tauri/src/menu.rs:28; the Popup destination and matcher are desktop/src-tauri/src/popup.rs:256-263,313-320; and the icon generator's render/produced/check chain is desktop/scripts/generate-icons.ts:62-145,157-175. The pinned Tauri set_icon API is called through the existing tray handle at desktop/src-tauri/src/tray.rs:104-107,463-465; B also compiles it against the checked-in Cargo.lock. The AppKit NSButtonCell.imageRect(forBounds:) call was checked with the swift verifier below.

## File change map and executable patches

The following are the entire commit-2 file set. DELETE: none. Binary NEW output is generated, not hand-edited. MODIFY rows with an insertion block mean insert at the named existing anchor; replacement blocks name the exact old expression. Commit 1 changed src/update/badge.ts: its 40-hour cache-age guard and `unknown` result remain package-only. Change only the installer type line shown here; the desktop store supplies the same seven-field response independently.

| Operation | Path | Change |
| --- | --- | --- |
| NEW | src/update/desktop-badge.ts | Strict snapshot DTO, bounded process store, desktop badge projection; full content below. |
| MODIFY | src/update/badge.ts | Widen only UpdateBadge.installer to include desktop. |
| MODIFY | src/server/management/sidebar-routes.ts | Desktop GET branch and admin-token POST with bounded stream read. |
| MODIFY | src/server/management/route-registry.ts | Declare POST and truthful desktop-internal parity exemption. |
| MODIFY | desktop/src-tauri/src/proxy.rs | Bound POST JSON through existing identity-checked client. |
| MODIFY | desktop/src-tauri/src/updater.rs | Random session, serial snapshot publisher, state transitions and 60 s heartbeat. |
| MODIFY | desktop/src-tauri/src/lib.rs | Manage and start the snapshot publisher. |
| MODIFY | desktop/src-tauri/src/startup.rs | Carry session in embedded dashboard URL; wake publisher on bind. |
| MODIFY | desktop/src-tauri/src/native_tray.rs | Borrow status button on main thread for dot bridge. |
| MODIFY | app/Sources/NativeTray/Popover.swift | NSView dot, @_cdecl show/hide bridge, image-relative drawing. |
| MODIFY | desktop/src-tauri/src/tray.rs | Apply native/PNG indicator on updater/tray state and title refresh. |
| MODIFY | desktop/src-tauri/src/popup.rs | Preserve the session when the web tray opens the main dashboard. |
| MODIFY | desktop/scripts/generate-icons.ts | Generate and check a dotted PNG from tray/icon.svg plus SVG halo/dot. |
| NEW generated | desktop/src-tauri/icons/tray/icon-update.png | 44×44 RGBA, output of the generator; no hand-authored binary. |
| MODIFY | gui/src/lib/desktop-shell.ts | Strict session query reader and badge URL helper. |
| MODIFY | gui/src/components/sidebar-github-row.tsx | Desktop-session poll URL and 60 s cadence. |
| NEW | tests/update/update-desktop-badge.test.ts | Full test content below. |
| MODIFY | tests/server/sidebar-routes.test.ts | Principal, malformed ingress, absent/expiry/isolation route tests. |
| MODIFY | tests/server/management-route-registry.test.ts | Registry row and exemption check. |
| MODIFY | tests/cli/cli-capabilities.test.ts | Assert that the desktop-only POST is deliberately not a CLI capability. |
| MODIFY | tests/ci-workflows/build-desktop-icon-set.test.ts | Generated dotted variant size/source/colour declaration. |
| MODIFY | gui/tests/desktop-shell.test.ts | Desktop URL, missing session, browser isolation. |
| MODIFY | scripts/test-layout/layout.json | Explicit owner for the new Bun test. |
| MODIFY | tests/fixtures/test-layout-expected.json | Same explicit owner. |
| MODIFY | structure/desktop-shell.md; structure/companion.md; structure/gui-and-management-api.md; structure/runtime.md; structure/ops/service-and-sidecars.md | Current-state contracts below; the last two own src/update/. |
| MODIFY | docs-site/src/content/docs/reference/management-api.md; docs-site/src/content/docs/guides/desktop-app.md and their existing fr, ja, ko, ru, tr, zh-cn, zh-tw siblings | User-facing contract below. |

### New src/update/desktop-badge.ts — full content

The current UpdateBadge shape has currentVersion, latestVersion, channel, installer, canUpdate, updateAvailable and unknown (src/update/badge.ts:6-18). The commit-1 package reader returns `unknown: true` for missing, wrong-channel, invalid-time, future-time or 40-hour-stale cache; the desktop store must use its receipt TTL instead and must not read that cache. Keep precisely that response shape; do not include sessionId or phase in GET output. A session id is a routing nonce, not an install credential. The map is bounded even if clients continually change ids. Expiry is measured from *receipt*, so a six-hour updater check remains displayable while the heartbeat continues.

~~~ts
import type { UpdateBadge } from "./badge";
import { defaultUpdateTag } from "./index";

export type DesktopPhase =
  | "idle" | "checking" | "available" | "current"
  | "error" | "installing" | "install-failed";

export interface DesktopSnapshot {
  sessionId: string;
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  checkedAtMs: number | null;
  phase: DesktopPhase;
}

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const PHASES = new Set<DesktopPhase>([
  "idle", "checking", "available", "current", "error", "installing", "install-failed",
]);
export const DESKTOP_SNAPSHOT_TTL_MS = 180_000;
export const DESKTOP_SNAPSHOT_MAX_SESSIONS = 32;
const MIN_DESKTOP_CHECKED_AT_MS = 946_684_800_000; // 2000-01-01 UTC
const MAX_DESKTOP_CLOCK_SKEW_MS = 60_000;

export function validDesktopSession(value: unknown): value is string {
  return typeof value === "string" && SESSION.test(value);
}

export function parseDesktopSnapshot(value: unknown, nowMs: number): DesktopSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "available,checkedAtMs,currentVersion,latestVersion,phase,sessionId") return null;
  if (!validDesktopSession(body.sessionId)
    || typeof body.currentVersion !== "string" || !VERSION.test(body.currentVersion)
    || (body.latestVersion !== null && (typeof body.latestVersion !== "string" || !VERSION.test(body.latestVersion)))
    || typeof body.available !== "boolean"
    || typeof body.phase !== "string" || !PHASES.has(body.phase as DesktopPhase)) return null;
  const checked = body.checkedAtMs;
  if (checked !== null && (typeof checked !== "number" || !Number.isSafeInteger(checked) || checked < 0
    || checked < MIN_DESKTOP_CHECKED_AT_MS
    || checked > nowMs + MAX_DESKTOP_CLOCK_SKEW_MS)) return null;
  if (body.available !== (body.latestVersion !== null)) return null;
  if (body.available && checked === null) return null;
  if (body.phase === "available" && !body.available) return null;
  if (body.phase === "current" && (body.available || checked === null)) return null;
  if (body.phase === "idle" && (body.available || checked !== null)) return null;
  if ((body.phase === "installing" || body.phase === "install-failed") && !body.available) return null;
  return body as unknown as DesktopSnapshot;
}

export class DesktopBadgeStore {
  private readonly entries = new Map<string, { snapshot: DesktopSnapshot; receivedAtMs: number }>();
  constructor(
    private readonly wallNowMs: () => number = Date.now,
    private readonly elapsedNowMs: () => number = () => performance.now(),
  ) {}

  put(value: unknown): boolean {
    const snapshot = parseDesktopSnapshot(value, this.wallNowMs());
    if (!snapshot) return false;
    const now = this.elapsedNowMs();
    this.prune(now);
    this.entries.delete(snapshot.sessionId);
    while (this.entries.size >= DESKTOP_SNAPSHOT_MAX_SESSIONS) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(snapshot.sessionId, { snapshot, receivedAtMs: now });
    return true;
  }

  read(sessionId: string | null): UpdateBadge {
    const now = this.elapsedNowMs();
    this.prune(now);
    const snapshot = sessionId && validDesktopSession(sessionId)
      ? this.entries.get(sessionId)?.snapshot : undefined;
    if (!snapshot) return {
      updateAvailable: false, currentVersion: "?", latestVersion: null,
      channel: "latest", installer: "desktop", canUpdate: true, unknown: true,
    };
    return {
      updateAvailable: snapshot.available,
      currentVersion: snapshot.currentVersion,
      latestVersion: snapshot.latestVersion,
      channel: defaultUpdateTag(snapshot.currentVersion),
      installer: "desktop",
      canUpdate: true,
      unknown: snapshot.phase === "idle"
        || ((snapshot.phase === "checking" || snapshot.phase === "error") && !snapshot.available),
    };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.receivedAtMs >= DESKTOP_SNAPSHOT_TTL_MS) this.entries.delete(key);
    }
  }
}

export const desktopBadgeStore = new DesktopBadgeStore();
~~~

Before this parser edit, the last guard was `checked < nowMs - 24 * 60 * 60_000`; after, the two named bounds in the block above enforce only pre-2000 and >60-second-future rejection. `checkedAtMs` records when the native updater last settled; it is not a freshness lease. A 25-hour-old successful check remains valid if the living shell continues to send the same pending snapshot. `DesktopBadgeStore.put()` stamps each accepted POST with a new monotonic receipt time, and `read()` expires that receipt after 180 seconds without a heartbeat. The absolute lower bound rejects nonsensical timestamps without coupling display lifetime to check cadence. A null timestamp remains valid only for phases permitted by the schema.

MODIFY src/update/badge.ts:12: replace only the installer declaration. Exact current before: `installer: ReturnType<typeof detectInstall>;`. Keep `UpdateBadgeDeps.now`, the cache-age guard, and every other field unchanged. After:

~~~ts
installer: ReturnType<typeof detectInstall> | "desktop";
~~~

MODIFY src/server/management/sidebar-routes.ts:100-103. Keep the existing package GET exactly for an absent surface; add the POST and desktop branch *before* it. Management authentication happens before handleManagementAPI in the listener, but this route must additionally use ctx.principal, not request headers: src/server/management-auth.ts:555-563 gives the raw token the exact "admin-token" principal, while a GUI session yields "gui-session". Direct-dispatch tests with undefined principal also fail closed. The outer 2 MiB Content-Length check at src/server/management-api.ts:198-205 is insufficient for this 1 KiB schema, so the route measures bytes as it reads. The following is the exact block to insert immediately before the old badge GET:

~~~ts
  if (url.pathname === "/api/update/desktop-snapshot" && req.method === "POST") {
    if (ctx.principal !== "admin-token") {
      return jsonResponse({ error: "desktop snapshot requires admin token" }, 403, req, ctx.config);
    }
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return jsonResponse({ error: "invalid desktop snapshot" }, 400, req, ctx.config);
    }
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > 1024) {
      return jsonResponse({ error: "desktop snapshot too large" }, 413, req, ctx.config);
    }
    const reader = req.body?.getReader();
    if (!reader) return jsonResponse({ error: "invalid desktop snapshot" }, 400, req, ctx.config);
    const bytes = new Uint8Array(1024);
    let used = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (used + part.value.length > bytes.length) {
          await reader.cancel();
          return jsonResponse({ error: "desktop snapshot too large" }, 413, req, ctx.config);
        }
        bytes.set(part.value, used);
        used += part.value.length;
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
      const { desktopBadgeStore } = await import("../../update/desktop-badge");
      if (!desktopBadgeStore.put(JSON.parse(decoded))) {
        return jsonResponse({ error: "invalid desktop snapshot" }, 400, req, ctx.config);
      }
    } catch {
      return jsonResponse({ error: "invalid desktop snapshot" }, 400, req, ctx.config);
    }
    return jsonResponse({ ok: true }, 200, req, ctx.config);
  }

  if (url.pathname === "/api/update/badge" && req.method === "GET"
    && url.searchParams.get("surface") === "desktop") {
    const { desktopBadgeStore } = await import("../../update/desktop-badge");
    return jsonResponse(desktopBadgeStore.read(url.searchParams.get("session")), 200, req, ctx.config);
  }
~~~

Immediately before the old package GET, also reject any other nonempty surface with a fixed 400; this prevents a misspelled desktop surface silently reading the package badge:

~~~ts
  if (url.pathname === "/api/update/badge" && req.method === "GET"
    && url.searchParams.has("surface") && url.searchParams.get("surface") !== "desktop") {
    return jsonResponse({ error: "invalid badge surface" }, 400, req, ctx.config);
  }
~~~

Do not log request URLs, body, session id, or a parse exception. No body or session id is echoed. An authenticated ordinary browser can GET a known desktop session; the id is display routing, not an installation authorization.

MODIFY src/server/management/route-registry.ts:28-60 and :350-353. Add to ExemptionReason, before "deferred-verb":

~~~ts
  /** Desktop shell's internal display-state POST; the CLI has no app updater state to publish. */
  | "desktop-internal"
~~~

Add after the existing GET badge row:

~~~ts
  { method: "POST", path: "/api/update/desktop-snapshot",
    module: "server/management/sidebar-routes", mutates: true,
    exempt: { reason: "desktop-internal",
      why: "Only the Tauri shell has signed-updater state to publish; a CLI verb could only forge that state and would not create an operator action." } },
~~~

The row is a process-state mutation, hence mutates: true. The CLI parity ratchet at tests/cli/cli-capabilities.test.ts:343-370 requires the exemption, and "local-transport" would be false because ProxyClient sends HTTP. The registry stays pure data.

### Rust transport and state

MODIFY desktop/src-tauri/src/proxy.rs:1-8,181-228. The new method goes immediately before request(). It uses the same authorised_token() identity/generation check (desktop/src-tauri/src/proxy.rs:191-209) and the same no-redirect/no-system-proxy client (desktop/src-tauri/src/proxy.rs:82-100). It never accepts a caller-supplied URL.

~~~rust
    pub async fn post_desktop_snapshot(&self, body: &Value) -> Result<(), ProxyError> {
        let token = self.authorised_token().await?;
        let response = self.client
            .post(self.endpoint.url("/api/update/desktop-snapshot"))
            .header("X-OpenCodex-API-Key", token)
            .json(body)
            .send().await.map_err(|error| {
                if error.is_connect() { ProxyError::Unreachable } else { ProxyError::Decode(error) }
            })?;
        let _ = decode(response).await?;
        Ok(())
    }
~~~

MODIFY desktop/src-tauri/src/updater.rs:1-6,81-114 and :116-144. Add imports and the following exact definitions above PendingUpdate. No new dependency: uuid v4 is already pinned in desktop/src-tauri/Cargo.toml:21 and used in desktop/src-tauri/src/identity.rs:19,48; serde_json and tokio are already used by desktop/src-tauri/src/proxy.rs:2-8. The publisher is a single serial task, so a late heartbeat cannot overwrite a later updater transition at the proxy. Native checks also need their own ordering gate: serialization of POSTs cannot correct a stale result already applied to PendingUpdate, tray, and the snapshot.

~~~rust
use serde::Serialize;
use serde_json::to_value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Clone)]
pub enum UiProjection { Available(String), Current }

#[derive(Clone)]
struct UiUpdate { revision: u64, projection: UiProjection }

pub struct CheckGeneration {
    latest_started: AtomicU64,
    install_epoch: AtomicU64,
    application: Mutex<()>,
    latest_ui_revision: AtomicU64,
    ui: watch::Sender<Option<UiUpdate>>,
}

impl Default for CheckGeneration {
    fn default() -> Self {
        let (ui, _) = watch::channel(None);
        Self { latest_started: AtomicU64::new(0), install_epoch: AtomicU64::new(0),
            application: Mutex::new(()), latest_ui_revision: AtomicU64::new(0), ui }
    }
}

impl CheckGeneration {
    pub fn begin_if_not_installing(
        &self, installing: &std::sync::atomic::AtomicBool, publish_checking: impl FnOnce(),
    ) -> Option<(u64, u64)> {
        let _guard = self.application.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if installing.load(Ordering::Acquire) { return None; }
        let generation = self.latest_started.fetch_add(1, Ordering::AcqRel) + 1;
        let epoch = self.install_epoch.load(Ordering::Acquire);
        publish_checking();
        Some((generation, epoch))
    }

    // Commit 3 uses this for both the tray and page install paths.
    pub fn claim_install(&self, installing: &std::sync::atomic::AtomicBool) -> bool {
        let _guard = self.application.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if installing.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return false;
        }
        self.install_epoch.fetch_add(1, Ordering::AcqRel);
        // Invalidate a queued check projection before the install can take PendingUpdate.
        self.latest_ui_revision.fetch_add(1, Ordering::AcqRel);
        true
    }

    pub fn epoch_is_current(&self, epoch: u64) -> bool {
        self.install_epoch.load(Ordering::Acquire) == epoch
    }

    pub fn apply_if_current<T>(&self, generation: u64, apply: impl FnOnce() -> T) -> Option<T> {
        let _guard = self.application.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.latest_started.load(Ordering::Acquire) != generation { return None; }
        Some(apply())
    }

    pub fn inspect<T>(&self, read: impl FnOnce() -> T) -> T {
        let _guard = self.application.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        read()
    }

    // Call only inside application/inspect. This is an in-memory send, never a Tauri setter.
    fn queue_ui(&self, projection: UiProjection) {
        let revision = self.latest_ui_revision.fetch_add(1, Ordering::AcqRel) + 1;
        self.ui.send_replace(Some(UiUpdate { revision, projection }));
    }

    fn apply_ui_projection_if_current(
        &self, update: UiUpdate, apply: impl FnOnce(UiProjection),
    ) -> bool {
        // A short atomic check only. In particular, never take application here.
        if update.revision != self.latest_ui_revision.load(Ordering::Acquire) { return false; }
        apply(update.projection);
        true
    }
}

pub fn start_ui_projection_worker(app: AppHandle) {
    let mut receiver = app.state::<CheckGeneration>().ui.subscribe();
    tauri::async_runtime::spawn(async move {
        while receiver.changed().await.is_ok() {
            let Some(update) = receiver.borrow_and_update().clone() else { continue; };
            // One worker serializes all updater menu/icon calls. A newer transition wins;
            // if one setter is already waiting on AppKit, the latest queued state follows it.
            app.state::<CheckGeneration>().apply_ui_projection_if_current(update, |projection| {
                match projection {
                    UiProjection::Available(version) => tray::show_update_available(&app, &version),
                    UiProjection::Current => tray::show_up_to_date(&app),
                }
            });
        }
    });
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    session_id: String,
    current_version: String,
    latest_version: Option<String>,
    available: bool,
    checked_at_ms: Option<u64>,
    phase: &'static str,
}

pub struct DesktopUpdateState {
    session_id: String,
    tx: watch::Sender<DesktopSnapshot>,
}

impl DesktopUpdateState {
    pub fn new(current_version: String) -> Self {
        let session_id = Uuid::new_v4().to_string();
        let (tx, _) = watch::channel(DesktopSnapshot {
            session_id: session_id.clone(), current_version, latest_version: None,
            available: false, checked_at_ms: None, phase: "idle",
        });
        Self { session_id, tx }
    }

    pub fn session_id(&self) -> &str { &self.session_id }

    pub fn publish(&self, phase: &'static str, latest: Option<String>, checked: Option<u64>) {
        let previous = self.tx.borrow().clone();
        let next = DesktopSnapshot {
            session_id: self.session_id.clone(),
            current_version: previous.current_version,
            available: latest.is_some(),
            latest_version: latest,
            checked_at_ms: checked,
            phase,
        };
        self.tx.send_replace(next);
    }

    pub fn retain_phase(&self, phase: &'static str) {
        let previous = self.tx.borrow().clone();
        self.publish(phase, previous.latest_version, previous.checked_at_ms);
    }

    pub fn wake(&self) {
        let snapshot = self.tx.borrow().clone();
        self.tx.send_replace(snapshot);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .unwrap_or_default().as_millis().min(u128::from(u64::MAX)) as u64
}

pub fn start_snapshot_publisher(app: AppHandle) {
    let mut receiver = app.state::<DesktopUpdateState>().tx.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let snapshot = receiver.borrow_and_update().clone();
            if let Some(proxy) = app.try_state::<crate::AppState>().and_then(|state| state.proxy()) {
                if let Ok(body) = to_value(&snapshot) {
                    let _ = proxy.post_desktop_snapshot(&body).await;
                }
            }
            tokio::select! {
                changed = receiver.changed() => if changed.is_err() { break; },
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
            }
        }
    });
}
~~~

The publisher swallows transport failures as best-effort display state. The next state change or 60 s tick retries. It does not log identifiers or errors. At most one POST is in flight from this shell. The 4 s client timeout is already set at desktop/src-tauri/src/proxy.rs:85-86. The sender lives for the app lifetime, so changed() normally stays open.

Replace check_and_show() at desktop/src-tauri/src/updater.rs:91-114 with this complete body. Before, the function ran `match check(app).await` and applied each `Some`/`None` immediately; the complete after-body is below. `begin_if_not_installing` checks the install flag and publishes `"checking"` under the same short `application` mutex used by `claim_install` (commit 3) and `apply_if_current`. The result closure holds that mutex through the install guard, pending model, tray's pure `update_pending` flag, snapshot, and UI projection enqueue; an install claim cannot enter between its guard and those writes. The serialized projection worker applies menu, icon, and native overlay setters after the gate has been released. No mutex spans `check(app).await` or a Tauri setter. Every caller (the six-hour loop at updater.rs:81-89, tray manual action at tray.rs:192-196, and commit-3 page command) uses this one function.

~~~rust
pub async fn check_and_show(app: &AppHandle) {
    let gate = app.state::<CheckGeneration>();
    let state = app.state::<tray::TrayState>();
    let Some((generation, _epoch)) = gate.begin_if_not_installing(&state.installing, || {
        app.state::<DesktopUpdateState>().retain_phase("checking");
    }) else { return; };
    let answer = check(app).await;
    let applied_error = gate.apply_if_current(generation, || {
        if tray::is_installing(app) { return None; }
        match answer {
            Ok(Some(update)) => {
                let version = update.version.clone();
                if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                    *pending = Some(update);
                }
                app.state::<DesktopUpdateState>()
                    .publish("available", Some(version.clone()), Some(now_ms()));
                state.update_pending.store(true, Ordering::Release);
                gate.queue_ui(UiProjection::Available(version));
                None
            }
            Ok(None) => {
                if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                    *pending = None;
                }
                app.state::<DesktopUpdateState>().publish("current", None, Some(now_ms()));
                state.update_pending.store(false, Ordering::Release);
                gate.queue_ui(UiProjection::Current);
                None
            }
            Err(error) => {
                app.state::<DesktopUpdateState>().retain_phase("error");
                Some(error)
            }
        }
    }).flatten();
    if let Some(error) = applied_error { logging::log_once("updater check failed", &error); }
}
~~~

Commit 3 consumes `CheckGeneration::{begin_if_not_installing,claim_install,apply_if_current,epoch_is_current,inspect}` and the gate-private `queue_ui`. `begin_if_not_installing` returns the generation and epoch captured while it owns the gate, after rechecking the install flag and before publishing `"checking"`. `claim_install` takes the same gate for the flag CAS and epoch increment, invalidating queued check UI; commit 3 extends it to enqueue the install projection before release. `apply_if_current` returns `None` when another check started; `Some(T)` is the applied model result, and commit 3 compares the captured epoch inside its application closure before any state write. `inspect` lets the page read pending and checking status under the same gate. A stale result or error maps to `Ok(())` for the page without logging an obsolete failure. The UI worker checks `latest_ui_revision` immediately before each projection and serializes every updater menu/icon/overlay application; if a newer state arrives during a blocking setter, it applies afterward. The gate is managed once per app process immediately before the background checker can start. If a previous signed pending update exists, checking/error retains latestVersion and its blue dot; if not, error projects unknown. The Tauri updater still supplies the availability decision; the proxy never recomputes it.

MODIFY desktop/src-tauri/src/lib.rs:1-35,223-270: immediately after managing PendingUpdate, insert:

~~~rust
            app.manage(updater::DesktopUpdateState::new(app.package_info().version.to_string()));
            app.manage(updater::CheckGeneration::default());
            updater::start_ui_projection_worker(app.handle().clone());
            updater::start_snapshot_publisher(app.handle().clone());
~~~

Tauri's package_info() use already exists at desktop/src-tauri/src/menu.rs:28. Start the publisher independently of the release-build updater-check gate at lib.rs:268-270 so a debug shell can still produce an unknown desktop badge.

MODIFY desktop/src-tauri/src/startup.rs:1407-1438: replace the old endpoint.url("/#/usage") line at :1414 with:

~~~rust
    let path = format!(
        "/?desktop_session={}#/usage",
        app.state::<crate::updater::DesktopUpdateState>().session_id()
    );
    let dashboard = endpoint.url(&path);
~~~

After the existing if !emit(app, progress, None) { ... return; } block at startup.rs:1417-1421, add:

~~~rust
    app.state::<crate::updater::DesktopUpdateState>().wake();
~~~

The state is managed before startup::begin (desktop/src-tauri/src/lib.rs:223-266). This wake immediately retries only after a successful Ready publication; before bind, the publisher has no ProxyClient and sends nothing. Existing startup navigation retains the complete URL through progress.dashboard (startup.rs:1415-1435,1448-1487).

MODIFY desktop/src-tauri/src/popup.rs:256-263: the incoming web-tray link is still matched against DASHBOARD_PATH at :16 and :313-320. Replace main.navigate(url.clone()) with the following destination, leaving the source matcher unchanged:

~~~rust
                let session = app.state::<crate::updater::DesktopUpdateState>().session_id().to_string();
                let destination = endpoint.url(&format!("/?desktop=open&desktop_session={session}#/usage"));
                if let Ok(destination) = destination.parse() { let _ = main.navigate(destination); }
~~~

The popup's link stays at gui/src/pages/Tray.tsx:141,176, which already emits /?desktop=open#/usage, and popup.rs:313-320 recognizes it. Only the main webview destination gains the session. The external Open in Browser action at desktop/src-tauri/src/tray.rs:170-177 remains a package-view browser on purpose.

### Native and generated icon changes

MODIFY desktop/src-tauri/src/native_tray.rs:17-22: add the declaration to the existing extern block:

~~~rust
    fn ocx_native_tray_update_dot(item: *mut c_void, show: i32);
~~~

Add this function after present() at native_tray.rs:58-76. It gets a fresh status-item pointer each time; no borrowed pointer survives the closure. run_on_main_thread is already used in native_tray.rs:78-80.

~~~rust
pub fn set_update_dot(app: &AppHandle, _show: bool) {
    let app = app.clone();
    let target = app.clone();
    let _ = target.run_on_main_thread(move || {
        let Some(tray) = app.tray_by_id("main") else { return; };
        let pending = app.try_state::<crate::tray::TrayState>()
            .is_some_and(|state| state.update_pending.load(Ordering::Acquire));
        let _ = tray.with_inner_tray_icon(|inner| {
            if let Some(item) = inner.ns_status_item() {
                let pointer = (&*item as *const _ as *mut c_void).cast();
                unsafe { ocx_native_tray_update_dot(pointer, i32::from(pending)); }
            }
        });
    });
}
~~~

The main-thread closure reads the latest atomic pending value when it executes. A queued title refresh cannot re-show an already cleared dot with an older captured Boolean.

Also replace the static path selection in native_event() at native_tray.rs:95-102 so opening the main dashboard from the macOS panel retains the session:

~~~rust
                let session = app.state::<crate::updater::DesktopUpdateState>().session_id().to_string();
                let path = if event == 4 {
                    format!("/?desktop=open&desktop_session={session}#/usage/companion")
                } else {
                    format!("/?desktop=open&desktop_session={session}#/usage")
                };
                if let Ok(url) = proxy.endpoint().url(&path).parse() {
                    let _ = main.navigate(url);
                    window::show(&main);
                }
~~~

MODIFY app/Sources/NativeTray/Popover.swift:1-68. Insert this complete NSView implementation after the NativeTrayPopover class, before its existing @_cdecl exports:

~~~swift
@MainActor
private final class UpdateDotView: NSView {
    weak var statusButton: NSStatusBarButton?

    init(button: NSStatusBarButton) {
        statusButton = button
        super.init(frame: button.bounds)
        autoresizingMask = [.width, .height]
        // AppKit keeps the template image and its highlighted tint. This view draws only
        // the independent accent, without making the status button layer-backed.
        wantsLayer = false
    }

    required init?(coder: NSCoder) { nil }
    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let button = statusButton else { return }
        let imageRect = button.cell?.imageRect(forBounds: button.bounds) ?? button.bounds
        let image = imageRect.isEmpty ? button.bounds : imageRect
        let diameter: CGFloat = 7
        let dot = NSRect(x: min(bounds.maxX - diameter, image.maxX - 4),
                         y: max(bounds.minY, image.minY + 1),
                         width: diameter, height: diameter)
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(ovalIn: dot.insetBy(dx: -1.25, dy: -1.25)).fill()
        NSColor(calibratedRed: 0.18, green: 0.48, blue: 0.97, alpha: 1).setFill()
        NSBezierPath(ovalIn: dot).fill()
    }
}

@MainActor
private enum UpdateDot {
    static weak var button: NSStatusBarButton?
    static var view: UpdateDotView?

    static func set(_ item: NSStatusItem, visible: Bool) {
        guard let next = item.button else { return }
        if button !== next {
            view?.removeFromSuperview()
            view = nil
            button = next
        }
        guard visible else {
            view?.removeFromSuperview()
            view = nil
            return
        }
        if view == nil {
            let overlay = UpdateDotView(button: next)
            next.addSubview(overlay)
            view = overlay
        }
        view?.frame = next.bounds
        view?.needsDisplay = true
    }
}

@_cdecl("ocx_native_tray_update_dot")
@MainActor
public func nativeTrayUpdateDot(_ item: UnsafeMutableRawPointer?, _ show: Int32) {
    guard Thread.isMainThread, let item else { return }
    let statusItem = Unmanaged<NSStatusItem>.fromOpaque(item).takeUnretainedValue()
    UpdateDot.set(statusItem, visible: show != 0)
}
~~~

This uses the status button's imageRect, not the window theme. A title change calls the bridge again below; autoresizing/layout tracks button bounds. hitTest returning nil preserves status-button clicks and right-click menus. The overlay remains blue when AppKit highlights the template glyph; clearing removes the child view. A recreated status item replaces the weak button/view pair. The 7 pt dot and 1.25 pt halo are visual-QA values, not an API contract.

MODIFY desktop/src-tauri/src/tray.rs:20-39: add update_pending: AtomicBool to TrayState and initialize it false. Add this exact helper after Default:

~~~rust
#[cfg(any(not(target_os = "macos"), test))]
fn tray_icon_bytes(pending: bool) -> &'static [u8] {
    if pending { include_bytes!("../icons/tray/icon-update.png") }
    else { include_bytes!("../icons/tray/icon.png") }
}

fn apply_update_indicator(app: &AppHandle, pending: bool) {
    #[cfg(target_os = "macos")]
    popup::set_update_dot(app, pending);
    #[cfg(not(target_os = "macos"))]
    if let Some(tray) = app.tray_by_id("main") {
        let image = tauri::image::Image::from_bytes(tray_icon_bytes(pending))
            .expect("generated tray icon");
        let _ = tray.set_icon(Some(image));
    }
}

fn update_pending(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .is_some_and(|state| state.update_pending.load(Ordering::Acquire))
}
~~~

For show_update_available() at tray.rs:284-291, after its existing menu block insert only the setter-side redraw; `check_and_show` owns the atomic model write under `CheckGeneration`:

~~~rust
    apply_update_indicator(app, true);
~~~

For show_up_to_date() at :293-301, after its existing menu block insert:

~~~rust
    apply_update_indicator(app, false);
~~~

In TrayState at :20-39 add the exact field and Default initializer:

~~~rust
pub update_pending: AtomicBool,
// inside Default Self
update_pending: AtomicBool::new(false),
~~~

Keep it true through set_installing() at :308-319 and set_install_failed() at :321-325; additionally publish updater phase at those two functions. In commit 3, move these phase writes into gate-owned pure transitions and leave the renamed `show_installing` as a setter-only function called by `start_ui_projection_worker`:

~~~rust
// At end of set_installing:
app.state::<updater::DesktopUpdateState>().retain_phase("installing");
// At end of set_install_failed:
app.state::<updater::DesktopUpdateState>().retain_phase("install-failed");
~~~

Change both refresh_title call sites at tray.rs:244,261 to refresh_title(app, &tray, &proxy), and replace the function signature/body at :328-341 with:

~~~rust
fn refresh_title(app: &AppHandle, tray: &tauri::tray::TrayIcon<Wry>, proxy: &ProxyClient) {
    let app = app.clone();
    let proxy = proxy.clone();
    let tray = tray.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(settings) = proxy.companion_settings().await else { return; };
        let Ok(usage) = proxy.usage_today().await else { return; };
        let quotas = proxy.quotas().await.unwrap_or(Value::Null);
        let title = render_title(&settings, &usage, &quotas);
        let _ = tray.set_title(title.as_deref());
        #[cfg(target_os = "macos")]
        apply_update_indicator(&app, update_pending(&app));
    });
}
~~~

Before this redraw edit, `apply_update_indicator(&app, update_pending(&app));` ran unconditionally after `tray.set_title`. The after-body above wraps that call in `#[cfg(target_os = "macos")]`: it repositions only the Swift dot against the image whenever the title changes. Windows/Linux do not call set_icon on the minute title refresh. Also insert apply_update_indicator(app, update_pending(app)); after tray construction at tray.rs:231 so late tray registration paints a pending state. Neither title refresh nor tray construction reads `CheckGeneration`, and neither holds its mutex across an AppKit call. On Windows/Linux set_icon only swaps RGBA PNGs at actual pending-state transitions or initial tray construction; the base glyph remains the existing 44 px image and is not redesigned.

MODIFY desktop/scripts/generate-icons.ts:62-145. Add next to TRAY_OUTPUT/TRAY_SIZE:

~~~ts
const DOTTED_TRAY_OUTPUT = "tray/icon-update.png";
const DOTTED_TRAY_SVG = '<g id="update-dot"><circle cx="409" cy="395" r="48" fill="#ffffff"/><circle cx="409" cy="395" r="34" fill="#2f81f7"/></g>';

function renderDottedTray(target: string): void {
  const dottedSvg = join(target, ".tray-update.svg");
  const base = readFileSync(traySource, "utf8");
  if (!base.includes("</svg>")) throw new Error("tray icon source is not SVG");
  writeFileSync(dottedSvg, base.replace("</svg>", DOTTED_TRAY_SVG + "</svg>"));
  try { render(TRAY_SIZE, join(target, DOTTED_TRAY_OUTPUT), dottedSvg); }
  finally { rmSync(dottedSvg, { force: true }); }
}
~~~

After existing render(TRAY_SIZE, join(target, TRAY_OUTPUT), traySource); produced.push(TRAY_OUTPUT); at generate-icons.ts:126-128, add:

~~~ts
  renderDottedTray(target);
  produced.push(DOTTED_TRAY_OUTPUT);
~~~

The source is the existing desktop/src-tauri/icons/tray/icon.svg plus this SVG halo/dot, rendered by the same SVG renderer. That is a single source for both variants: no copied glyph paths, no Windows light/dark redesign. The existing generator's produced list makes --check compare the new PNG byte-for-byte on the same renderer (generate-icons.ts:133-175). The generated PNG is the complete content of the NEW binary file; B runs bun run icons in desktop/ and commits that output. No literal PNG bytes belong in a text PRD.

### Embedded GUI poll

MODIFY gui/src/lib/desktop-shell.ts:1-32. Add after isDesktopShell() at :11-13. This deliberately requires both the desktop user agent (desktop/src-tauri/src/window.rs:4-14) and a valid UUID v4 in the URL, so a copied query in a normal browser cannot silently select the desktop surface. A desktop shell with no session still asks for the desktop surface and receives unknown; it never falls back to package state.

~~~ts
const DESKTOP_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function desktopSession(search = typeof location === "undefined" ? "" : location.search): string | null {
  const value = new URLSearchParams(search).get("desktop_session");
  return value && DESKTOP_SESSION.test(value) ? value : null;
}

export function updateBadgeUrl(apiBase: string, ua?: string, search?: string): string {
  const base = apiBase + "/api/update/badge";
  if (!isDesktopShell(ua)) return base;
  const session = desktopSession(search);
  return base + "?surface=desktop" + (session ? "&session=" + encodeURIComponent(session) : "");
}
~~~

MODIFY gui/src/components/sidebar-github-row.tsx:18-40,67-76. Import updateBadgeUrl and isDesktopShell from ../lib/desktop-shell. Before badgePoll, compute badgeUrl = updateBadgeUrl(apiBase); replace the badge keyed resource's key/dependency/fetch/poll settings with:

~~~tsx
  const badgeUrl = updateBadgeUrl(apiBase);
  const badgePoll = useKeyedClientResource(
    "sidebar-update-badge:" + badgeUrl,
    [badgeUrl],
    (signal) => readJson<UpdateBadge>(badgeUrl, signal),
    { pollMs: isDesktopShell() ? 60_000 : BADGE_POLL_MS },
  );
~~~

Widen the local UpdateBadge.installer union to include "desktop" at sidebar-github-row.tsx:23-30. No new visible copy or i18n key is introduced here. Commit 3 routes the two desktop click actions to the app-origin update page; until then this commit only changes the signal. Keep normal-browser /api/update/badge unchanged.

## Tests and exact additions

NEW tests/update/update-desktop-badge.test.ts — full content:

~~~ts
import { describe, expect, test } from "bun:test";
import {
  DESKTOP_SNAPSHOT_MAX_SESSIONS,
  DESKTOP_SNAPSHOT_TTL_MS,
  DesktopBadgeStore,
  parseDesktopSnapshot,
} from "../../src/update/desktop-badge";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALL_MS = 1_700_000_000_000;
const snapshot = (sessionId: string) => ({
  sessionId, currentVersion: "2.61.0", latestVersion: "2.62.0",
  available: true, checkedAtMs: WALL_MS, phase: "available",
});

describe("desktop badge snapshot store", () => {
  test("rejects extra fields, malformed values and forged availability", () => {
    expect(parseDesktopSnapshot({ ...snapshot(A), token: "unwanted" }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), sessionId: "short" }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), currentVersion: "x".repeat(65) }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), latestVersion: null }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), phase: "installed" }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), checkedAtMs: WALL_MS + 60_001 }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), checkedAtMs: 946_684_799_999 }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), phase: "current" }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), phase: "installing", available: false, latestVersion: null }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot(snapshot(A), WALL_MS)).not.toBeNull();
  });

  test("an absent session is unknown desktop state, never package state", () => {
    const store = new DesktopBadgeStore(() => WALL_MS, () => 1_000);
    expect(store.read(A)).toMatchObject({
      installer: "desktop", unknown: true, updateAvailable: false,
      latestVersion: null, currentVersion: "?",
    });
    expect(store.read(null).unknown).toBe(true);
  });

  test("two desktop sessions do not see one another", () => {
    let now = 1_000;
    const store = new DesktopBadgeStore(() => WALL_MS, () => now);
    expect(store.put(snapshot(A))).toBe(true);
    expect(store.read(A).updateAvailable).toBe(true);
    expect(store.read(B).unknown).toBe(true);
    now += 1_000;
    expect(store.put({
      ...snapshot(B), latestVersion: null, available: false,
      phase: "current", checkedAtMs: WALL_MS,
    })).toBe(true);
    expect(store.read(A).updateAvailable).toBe(true);
    expect(store.read(B)).toMatchObject({
      installer: "desktop", updateAvailable: false, unknown: false,
    });
  });

  test("a failed check is unknown without pending state but retains a known update", () => {
    const store = new DesktopBadgeStore(() => WALL_MS, () => 1_000);
    expect(store.put({
      ...snapshot(A), latestVersion: null, available: false,
      checkedAtMs: null, phase: "error",
    })).toBe(true);
    expect(store.read(A)).toMatchObject({ unknown: true, updateAvailable: false });
    expect(store.put({ ...snapshot(A), phase: "error" })).toBe(true);
    expect(store.read(A)).toMatchObject({ unknown: false, updateAvailable: true });
  });

  test("a heartbeat extends receipt expiry and stale state disappears", () => {
    let now = 1_000;
    const store = new DesktopBadgeStore(() => WALL_MS, () => now);
    expect(store.put(snapshot(A))).toBe(true);
    now += 60_000;
    expect(store.put(snapshot(A))).toBe(true);
    now += DESKTOP_SNAPSHOT_TTL_MS - 1;
    expect(store.read(A).updateAvailable).toBe(true);
    now += 1;
    expect(store.read(A).unknown).toBe(true);
  });

  test("a 25-hour-old check remains visible while heartbeats renew receipt", () => {
    let received = 1_000;
    const store = new DesktopBadgeStore(() => WALL_MS + 25 * 60 * 60_000, () => received);
    expect(store.put(snapshot(A))).toBe(true);
    received += 60_000;
    expect(store.put({ ...snapshot(A), phase: "error" })).toBe(true);
    expect(store.read(A)).toMatchObject({ updateAvailable: true, unknown: false });
    received += DESKTOP_SNAPSHOT_TTL_MS - 1;
    expect(store.read(A).updateAvailable).toBe(true);
    received += 1;
    expect(store.read(A)).toMatchObject({ updateAvailable: false, unknown: true });
  });

  test("new sessions evict the oldest after the fixed entry limit", () => {
    const store = new DesktopBadgeStore(() => WALL_MS, () => 1_000);
    expect(store.put(snapshot(A))).toBe(true);
    for (let index = 0; index < DESKTOP_SNAPSHOT_MAX_SESSIONS; index++) {
      const id = "00000000-0000-4000-8000-" + index.toString(16).padStart(12, "0");
      expect(store.put(snapshot(id))).toBe(true);
    }
    expect(store.read(A).unknown).toBe(true);
    expect(store.read("00000000-0000-4000-8000-00000000001f").updateAvailable).toBe(true);
  });
});
~~~

MODIFY tests/server/sidebar-routes.test.ts:23-38. Keep its existing `call()` helper and add the following helper immediately after its closing brace at line 38, before `withStarDeps()`. Direct dispatch already models principal selection (lines 23-38); no real admin token is put into fixtures.

~~~ts
const DESKTOP_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DESKTOP_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const desktopPayload = (sessionId = DESKTOP_A) => ({
  sessionId, currentVersion: "2.61.0", latestVersion: "2.62.0",
  available: true, checkedAtMs: Date.now(), phase: "available",
});

async function desktopPost(body: string | Uint8Array, principal?: "admin-token" | "gui-session",
  contentType = "application/json") {
  const url = new URL("http://127.0.0.1:10100/api/update/desktop-snapshot");
  const req = new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1:10100", "content-type": contentType },
    body,
  });
  const response = await handleManagementAPI(req, url, config, {}, principal);
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() as Record<string, unknown> };
}
~~~

Add after the existing GET badge describe, which now includes commit 1's read-only cache test and closes at sidebar-routes.test.ts:139; insert before the `GET /api/github/star` describe at line 141:

~~~ts
describe("desktop snapshot route", () => {
  test("requires the raw admin-token principal, not a GUI session or missing principal", async () => {
    const body = JSON.stringify(desktopPayload());
    expect((await desktopPost(body)).status).toBe(403);
    expect((await desktopPost(body, "gui-session")).status).toBe(403);
    expect((await desktopPost(body, "admin-token")).status).toBe(200);
  });

  test("rejects extra fields, malformed JSON and over-1KiB streams without echoing input", async () => {
    expect((await desktopPost(JSON.stringify({ ...desktopPayload(), token: "sentinel" }), "admin-token")).status).toBe(400);
    expect((await desktopPost("{", "admin-token")).status).toBe(400);
    expect((await desktopPost("", "admin-token")).status).toBe(400);
    expect((await desktopPost(new Uint8Array([0xff]), "admin-token")).status).toBe(400);
    expect((await desktopPost(JSON.stringify(desktopPayload()), "admin-token", "text/plain")).status).toBe(400);
    const oversized = await desktopPost("x".repeat(1025), "admin-token");
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(oversized.body)).not.toContain("x".repeat(32));
  });

  test("desktop GET isolates sessions and never reads the package badge for an absent session", async () => {
    expect((await desktopPost(JSON.stringify(desktopPayload()), "admin-token")).status).toBe(200);
    const seen = await call("GET", "/api/update/badge?surface=desktop&session=" + DESKTOP_A);
    expect(seen.body).toMatchObject({ installer: "desktop", updateAvailable: true, unknown: false });
    expect(seen.raw).not.toContain(DESKTOP_A);
    const other = await call("GET", "/api/update/badge?surface=desktop&session=" + DESKTOP_B);
    expect(other.body).toMatchObject({ installer: "desktop", updateAvailable: false, unknown: true });
    const missing = await call("GET", "/api/update/badge?surface=desktop");
    expect(missing.body).toMatchObject({ installer: "desktop", unknown: true });
    expect((await call("GET", "/api/update/badge")).body).not.toMatchObject({ installer: "desktop" });
    expect((await call("GET", "/api/update/badge?surface=typo")).status).toBe(400);
  });
});
~~~

MODIFY tests/server/management-route-registry.test.ts:214-260: add this test inside the exemption describe:

~~~ts
  test("desktop snapshot is declared as a bounded internal shell mutation", () => {
    const row = MANAGEMENT_ROUTES.find(r =>
      r.method === "POST" && r.path === "/api/update/desktop-snapshot");
    expect(row).toMatchObject({
      module: "server/management/sidebar-routes", mutates: true,
      exempt: { reason: "desktop-internal" },
    });
  });
~~~

MODIFY tests/cli/cli-capabilities.test.ts:342-371: add inside the capability/route parity describe:

~~~ts
  test("desktop snapshot has an explicit internal exemption, not an operator CLI verb", async () => {
    const { MANAGEMENT_ROUTES } = await import("../../src/server/management/route-registry");
    const row = MANAGEMENT_ROUTES.find(r => r.method === "POST"
      && r.path === "/api/update/desktop-snapshot");
    expect(row?.exempt?.reason).toBe("desktop-internal");
    expect(capabilityRouteKeys().has("POST /api/update/desktop-snapshot")).toBe(false);
  });
~~~

MODIFY tests/ci-workflows/build-desktop-icon-set.test.ts:175-251: add next to the menu bar size test. repoPath is already imported at :4-5; this test follows its source-oracle convention and requires no image renderer in CI.

~~~ts
  test("the generated dotted tray variant has the declared size and SVG halo", () => {
    const generator = generatorSource();
    expect(generator).toContain('const DOTTED_TRAY_OUTPUT = "tray/icon-update.png"');
    expect(generator).toContain('renderDottedTray(target);');
    expect(generator).toContain('produced.push(DOTTED_TRAY_OUTPUT);');
    expect(generator).toContain('fill="#ffffff"');
    expect(generator).toContain('fill="#2f81f7"');
    const normal = readFileSync(join(ICONS_DIR, "tray", "icon.png"));
    const dotted = readFileSync(join(ICONS_DIR, "tray", "icon-update.png"));
    expect(pngDimensions(dotted)).toEqual({ width: 44, height: 44 });
    expect(dotted[25]).toBe(RGBA);
    expect(dotted.equals(normal)).toBe(false);
  });
~~~

MODIFY gui/tests/desktop-shell.test.ts:1-37: import desktopSession and updateBadgeUrl from ../src/lib/desktop-shell; add:

~~~ts
  test("desktop session selects its badge, ordinary browser keeps package badge", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(desktopSession("?desktop_session=" + id)).toBe(id);
    expect(desktopSession("?desktop_session=not-a-uuid")).toBeNull();
    expect(updateBadgeUrl("", tauriMac, "?desktop_session=" + id))
      .toBe("/api/update/badge?surface=desktop&session=" + id);
    expect(updateBadgeUrl("", tauriMac, ""))
      .toBe("/api/update/badge?surface=desktop");
    expect(updateBadgeUrl("", "Mozilla/5.0 Chrome/140.0", "?desktop_session=" + id))
      .toBe("/api/update/badge");
  });
~~~

MODIFY desktop/src-tauri/src/updater.rs:116-144: inside the existing tests module import `CheckGeneration` and `DesktopUpdateState`, plus `std::sync::atomic::AtomicBool`, and add:

~~~rust
    #[test]
    fn desktop_snapshot_serializes_the_bounded_wire_fields() {
        let state = DesktopUpdateState::new("2.61.0".into());
        // A realistic epoch-millisecond value: the proxy parser rejects checkedAtMs before 2000-01-01.
        state.publish("available", Some("2.62.0".into()), Some(1_790_000_000_000));
        let value = serde_json::to_value(state.tx.borrow().clone()).unwrap();
        assert!(uuid::Uuid::parse_str(state.session_id()).is_ok());
        assert_eq!(value["sessionId"], state.session_id());
        assert_eq!(value["currentVersion"], "2.61.0");
        assert_eq!(value["latestVersion"], "2.62.0");
        assert_eq!(value["available"], true);
        assert_eq!(value["checkedAtMs"], 1_790_000_000_000u64);
        assert!(value["checkedAtMs"].as_u64().unwrap() >= 946_684_800_000); // same lower bound as the proxy parser
        assert_eq!(value["phase"], "available");
        assert_eq!(value.as_object().unwrap().len(), 6);
    }

    #[test]
    fn a_delayed_older_none_cannot_clear_a_newer_pending_update() {
        let checks = CheckGeneration::default();
        let installing = AtomicBool::new(false);
        let (older, _) = checks.begin_if_not_installing(&installing, || {}).unwrap();
        let (newer, _) = checks.begin_if_not_installing(&installing, || {}).unwrap();
        let mut pending: Option<&str> = None;
        let mut phase = "checking";
        assert_eq!(checks.apply_if_current(newer, || {
            pending = Some("2.62.0");
            phase = "available";
        }), Some(()));
        // The first lookup completes after the second one; model its Ok(None) transition.
        assert_eq!(checks.apply_if_current(older, || {
            pending = None;
            phase = "current";
        }), None);
        assert_eq!(pending, Some("2.62.0"));
        assert_eq!(phase, "available");
        let (third, _) = checks.begin_if_not_installing(&installing, || {}).unwrap();
        assert_eq!(checks.apply_if_current(newer, || { pending = None; }), None);
        assert_eq!(pending, Some("2.62.0"));
        assert_eq!(checks.apply_if_current(third, || { pending = None; }), Some(()));
        assert_eq!(pending, None);
    }

    #[test]
    fn checking_publication_rechecks_install_claim_inside_the_gate() {
        let checks = CheckGeneration::default();
        let installing = AtomicBool::new(false);
        assert!(checks.claim_install(&installing));
        let mut published = false;
        assert_eq!(checks.begin_if_not_installing(&installing, || { published = true; }), None);
        assert!(!published);
    }
~~~

MODIFY desktop/src-tauri/src/tray.rs:496-623: inside its existing tests module import tray_icon_bytes and add:

~~~rust
    #[test]
    fn dotted_tray_variant_is_distinct_and_both_variants_are_png() {
        let normal = tray_icon_bytes(false);
        let dotted = tray_icon_bytes(true);
        assert_eq!(&normal[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&dotted[..8], b"\x89PNG\r\n\x1a\n");
        assert_ne!(normal, dotted);
    }
~~~

All three proposed Rust tests are pure and run on this Mac. The Windows/Linux set_icon path still needs hosted builds and human visual review at 16/20/24/32 px. The Swift overlay needs local highlighted, dark/light, title-width and 1×/2× QA; no unit assertion proves its final pixels.

MODIFY scripts/test-layout/layout.json explicit object, alphabetical insertion between update-bun-ownership-lease and update-desktop-owner (layout.json:1655-1659):

~~~json
    "update-bun-ownership-lease.test.ts": "update",
    "update-desktop-badge.test.ts": "update",
    "update-desktop-owner.test.ts": "update",
~~~

MODIFY tests/fixtures/test-layout-expected.json similarly at :1481-1485:

~~~json
  "update-bun-ownership-lease.test.ts": "update",
  "update-desktop-badge.test.ts": "update",
  "update-desktop-owner.test.ts": "update",
~~~

The existing tests/test-layout-tooling.test.ts:248-250 asserts equality of both explicit maps. The new test imports source relatively as existing tests/update files do; any source-oracle path used by these additions goes through tests/helpers/repo-root.ts, as in the icon test.

## Field/value chains — PLAN-FIELD-CHAIN-01

| New value | Creation | Serialization | Deserialization | Consumers |
| --- | --- | --- | --- | --- |
| DesktopSnapshot.sessionId | UUID v4 at desktop/src-tauri/src/updater.rs DesktopUpdateState::new; one id per app process | serde_json in publisher, POST JSON via desktop/src-tauri/src/proxy.rs | strict UUID validation in src/update/desktop-badge.ts parseDesktopSnapshot | Map key there; embedded URL from desktop/src-tauri/src/startup.rs; gui/src/lib/desktop-shell.ts query; sidebar GET. No persistence. Never included in GET body. |
| currentVersion | app.package_info().version in desktop/src-tauri/src/lib.rs | Same POST | 64-character version validation in src/update/desktop-badge.ts | Desktop GET currentVersion and channel (defaultUpdateTag); GUI's existing badge DTO. |
| latestVersion | signed Tauri Update.version at desktop/src-tauri/src/updater.rs:100-104, or null on no update | Same POST | nullable validated version in src/update/desktop-badge.ts | Desktop GET latestVersion; gui/src/components/sidebar-github-row.tsx:89,138-140 label/dot; tray menu uses existing updater::update_label. |
| available | Derived solely from latestVersion in DesktopUpdateState::publish | Same POST | strict boolean and equivalence validation in desktop-badge.ts | Desktop GET updateAvailable; GUI orb and tray indicator. It grants no install authority. |
| checkedAtMs | now_ms() after an accepted settled Tauri check, null before first check | Same POST | finite safe integer, at or after 2000-01-01 UTC, no future over 60 s; no relative-age expiry | Stored for validation and future page status; not echoed by GET. A 25-hour-old check remains visible when heartbeat receipt is fresh. |
| phase enum idle/checking/available/current/error/installing/install-failed | updater.rs constructor, check_and_show(), tray.rs installing/failure arms | String in serde JSON POST | fixed set in desktop-badge.ts | Badge unknown for idle or error without pending; available remains true through checking/error/install; future commit-3 page may read native state, not this HTTP enum. N/A in GET because no phase field is exposed. |
| native check generation, install epoch, UI revision | CheckGeneration::begin_if_not_installing before each check() await; claim_install increments epoch and invalidates queued UI; accepted model transitions increment latest_ui_revision | Process-local atomics and in-memory watch projection; no wire representation | apply_if_current and claim_install share one mutex; inspect reads page status under it; one worker rechecks revision without taking that mutex | Only the latest-started check can change PendingUpdate, update_pending, or DesktopUpdateState; an install claim cannot interleave with model writes. Blocking Tauri setters run later on the serialized worker, so a superseded projection cannot be the final UI. |
| receipt time and Map entry | performance.now at desktop-badge.ts put; wall Date.now is used only for checkedAt validation | N/A; process memory only | N/A | monotonic prune on GET/POST; expires at 180 s even if wall clock moves; oldest eviction at 32; no disk/cache/CLI consumer. |
| surface=desktop and session query | URL from gui/src/lib/desktop-shell.ts only in Tauri UA; native Rust main URL carries desktop_session | HTTP GET query | sidebar-routes.ts URLSearchParams; validDesktopSession in store | desktop projection only; ordinary GET remains package badge; missing session yields unknown desktop. |
| installer="desktop" | src/update/desktop-badge.ts read | jsonResponse in sidebar-routes.ts | gui/src/components/sidebar-github-row.tsx UpdateBadge union | Commit-3 desktop click routing is the next consumer. The value is never passed to src/update/job.ts. |
| desktop-internal exemption | src/server/management/route-registry.ts declaration | N/A, static registry data | tests/server/management-route-registry.test.ts and tests/cli/cli-capabilities.test.ts import | Explains why no CLI capability maps the snapshot POST. |
| macOS dot state | TrayState.update_pending at desktop/src-tauri/src/tray.rs | i32 over native_tray.rs @_cdecl ABI | app/Sources/NativeTray/Popover.swift: nativeTrayUpdateDot | NSView child of current NSStatusBarButton; N/A to HTTP. |
| Windows/Linux dotted icon | desktop/scripts/generate-icons.ts SVG source composition | PNG at desktop/src-tauri/icons/tray/icon-update.png | tauri::image::Image::from_bytes in tray.rs | set_icon on available tray, normal PNG when cleared; Linux no host means no icon consumer. |

No new GUI i18n catalog key: the orb and its existing aria label remain at gui/src/components/sidebar-github-row.tsx:137-159. All ten gui/src/i18n/{en,de,fr,ja,ko,ru,tr,vi,zh,zh-TW}.ts files remain unchanged in this commit; commit 3 owns update-page copy.

## Conditional paths — C-ACTIVATION-GROUNDING-01

| Guard / fallback / timeout / error | Test activation | Observable effect |
| --- | --- | --- |
| Raw admin-token principal only | sidebar-routes test posts identical valid JSON with undefined, gui-session, admin-token | 403/403/200; no store write until third call. Management-auth.ts:557-561 supplies principals at real ingress. |
| Wrong Content-Type, malformed/extra JSON, version, UUID, phase, availability relation, future/pre-2000 check time | POST test includes text/plain and malformed JSON; parseDesktopSnapshot unit covers the schema and timestamp bounds | Fixed 400, no input echo, no update to previous valid snapshot. |
| >1024 body with and without Content-Length | Route test's 1025-byte Request stream plus a declared length request in an ingress fixture | 413 before storage; stream cancel on overrun. Existing 2 MiB management cap is independent. |
| No body / stream read failure / invalid UTF-8 | POST with empty body and Uint8Array invalid UTF-8; an aborting stream in a direct-dispatch route test at B | Fixed 400, never log parser text. |
| Unknown surface | GET surface=typo | 400, no package fallback. |
| Missing/malformed/foreign session | GET desktop without session, invalid UUID, and B while A is stored | Desktop installer, unknown true, updateAvailable false; package cache not read. |
| Initial shell before bind; bind failure or later proxy replacement | Publisher starts before AppState has a proxy; failed ProxyClient identity; startup finish wake after valid bind | No token/body sent to foreign endpoint; first successful bound send after wake; 60 s retry after transient failure. ProxyClient's existing 4 s timeout bounds each attempt. |
| Two checks settle in reverse order | Rust CheckGeneration state-transition test begins old then new, applies new Some, then attempts old None, followed by a third generation | Old None is rejected and leaves newer pending/phase intact; only the latest-started result changes native state. The separate serial publisher then sends that state in order. |
| Check projection waits on an AppKit setter while status is read | Commit-3 Rust `status_read_completes_while_check_ui_setter_is_blocked`: fake setter waits for concurrent `inspect` result | Status read completes before setter release because the gate protects only pure model writes and projection enqueue; the serialized worker never holds it across Tauri setters. |
| Check while installing | Rust `checking_publication_rechecks_install_claim_inside_the_gate` claims first, then tries `begin_if_not_installing` | No `"checking"` publication; pending state/dot stays. |
| Failed update check with/without prior pending | Inject failed updater result in a focused Rust state test; unit store reads error with/without latest | Prior pending stays visible; no pending reports unknown. Existing fixed-context log remains. |
| Install failed after PendingUpdate was taken | Existing tray.rs:198-222 failure arm with updater::install error | Pending restored, menu re-enabled, dot stays, phase install-failed. Signed download/install sequence unchanged. |
| Snapshot TTL, heartbeat, bounded entries | New Bun store tests advance fake monotonic clock 60 s / 180 s and insert 33 sessions; the 25-hour-old checkedAtMs test re-POSTs an error phase with pending state | A fresh receipt keeps an old but still-pending check visible; after 180 s without receipt it becomes unknown; oldest entry is evicted. |
| Minute title refresh on Windows/Linux | Review the cfg(target_os = "macos") line and platform build; title-refresh smoke on Windows/Linux | No set_icon call from title refresh; set_icon remains for pending transitions and first tray construction. |
| macOS status item absent/recreated; title width; highlight | Native visual QA: check before tray exists, change title, recreate status item, open menu | No crash if absent; child moves relative to image and stays blue while glyph template tint changes; clear removes it. |
| Windows/Linux tray host absent or set_icon failure | Linux session without AppIndicator; platform smoke with failing icon setter | No claimed tray signal, GUI badge still works; setter error cannot affect updater check. |
| Desktop UA without valid URL nonce | GUI helper test | Requests surface=desktop with no session and sees unknown; ordinary browser keeps package URL. |

## Structure and public documentation edits

The source ownership table in structure/INDEX.md:154 maps src/update/ to *both* structure/runtime.md and structure/ops/service-and-sidecars.md. This corrects the shorter commit-2 doc list in 000_plan.md; it does not change a decision D1-D3. structure/manifest.json:3 caps each structure page at 600 lines. structure/runtime.md is exactly 600/600 now, so replace one existing line in place and do not append. No new structure document or manifest entry is necessary. The other source-area owners listed in structure/INDEX.md:118-154 were reviewed for consequences; their existing transport/adapter contracts do not change.

MODIFY structure/runtime.md:159, exact one-line replacement. Preserve commit 1's package-refresh link and add the desktop state contract on the same line (600/600 stays 600/600). Current before:

~~~md
| Support | `src/lib/`, `src/storage/`, `src/usage/`, `src/update/` ([package refresh](ops/service-and-sidecars.md#package-cache-refresh)), `src/generated/` |
~~~

After:

~~~md
| Support | `src/lib/`, `src/storage/`, `src/usage/`, `src/update/` ([package refresh](ops/service-and-sidecars.md#package-cache-refresh); `desktop-badge.ts` holds bounded process-local display state, never install authority), `src/generated/` |
~~~

MODIFY structure/ops/service-and-sidecars.md:250-254, append the paragraph after the existing Package cache refresh text at line 254. That heading and its commit-1 scheduler/async-check paragraphs remain intact:

~~~md
The desktop badge snapshot in src/update/desktop-badge.ts is process-local display state keyed by a Tauri session id. A 60-second shell heartbeat renews receipt time; entries expire after 180 seconds and the store retains at most 32 sessions. It is separate from the package version cache and from the updater job/ownership transaction. A proxy restart reports unknown until a bound desktop shell republishes; no update installation can be authorized by this snapshot.
~~~

MODIFY structure/desktop-shell.md:149-164, insert after the existing in-app update paragraph:

~~~md
The Tauri updater also publishes a bounded desktop snapshot over its identity-bound ProxyClient. A random process-session id travels in the embedded dashboard URL, and the dashboard requests GET /api/update/badge?surface=desktop&session=<id>. A normal browser keeps the package badge. The shell posts each updater-state change and a 60-second heartbeat; if the proxy loses the snapshot or the shell stops, the desktop badge becomes unknown after 180 seconds. This display path never installs an update or replaces the signed Tauri result. The tray shows the same pending state: macOS draws a blue child NSView dot over the template status-item image; Windows/Linux swap a generated dotted PNG when a tray host exists. The Windows base glyph is unchanged.
~~~

MODIFY structure/companion.md:50-56, insert after the Tauri title paragraph:

~~~md
The update dot is independent of companion usage and title filtering. A title refresh asks the macOS status-button overlay to redraw against the current image rectangle; update availability still comes only from the Tauri updater state in desktop/src-tauri/src/updater.rs.
~~~

MODIFY structure/gui-and-management-api.md:168 and :195. Keep the current Updates row's asynchronous check/run and 40-hour package-cache sentences verbatim. Replace only its final sentence `The badge links to the update surface rather than gating other actions.` with the three-sentence text below, keeping it in the same table row; replace the complete current Sidebar row (`GET/POST /api/github/star` and `GET /api/update/badge`; cosmetic failure) with the second block:

~~~md
The badge links to the update surface rather than gating other actions. `GET /api/update/badge?surface=desktop&session=<id>` projects only that process-local Tauri session; missing or expired state is unknown and never falls back to the package cache. `POST /api/update/desktop-snapshot` is a 1 KiB bounded, admin-token-principal-only display-state mutation with no install permission.

| Sidebar | `src/server/management/sidebar-routes.ts` — `GET/POST /api/github/star`, `GET /api/update/badge`, and `POST /api/update/desktop-snapshot`. The POST accepts only the raw admin-token principal; GUI sessions cannot publish desktop state. Badge state is cosmetic and a failed poll degrades silently. |
~~~

MODIFY docs-site/src/content/docs/reference/management-api.md:547. Exact current before:

~~~md
| `GET /api/update/badge` | Read cached package badge state without a registry lookup; missing, wrong-channel or 40-hour-old cache returns `unknown: true`. | — |
~~~

Replace that row with these exact two rows. Put the desktop paragraph after the table and before the existing automatic-check paragraph at line 549; preserve that paragraph and the async check/run rows at lines 268-269:

~~~md
| `GET /api/update/badge` | Read cached package badge without a registry lookup; missing, wrong-channel or 40-hour-old cache returns `unknown: true`. `surface=desktop&session=<id>` reads only that desktop app session. | 400 invalid surface; missing or expired desktop session returns `unknown: true` |
| `POST /api/update/desktop-snapshot` | Desktop shell publishes its Tauri-updater display state through the bound proxy client | 403 unless the raw `admin-token` principal; 400 invalid fields; 413 over 1 KiB |

The desktop snapshot is temporary display state, not an install request. The proxy stores at most 32 sessions in memory and expires one 180 seconds after its last heartbeat. A normal browser without surface=desktop continues to read the package badge.
~~~

MODIFY docs-site/src/content/docs/guides/desktop-app.md: its existing "## Updates" section (currently below the tray usage section). Insert these exact sentences after the check cadence sentence:

~~~md
When the Tauri updater finds a newer app version, a blue dot appears on the macOS menu-bar icon or the Windows/Linux tray icon where a tray host is available. The embedded dashboard shows the same desktop update signal. A normal browser connected to the same proxy still shows the proxy package update state. If the shell stops reporting for about three minutes, the embedded badge becomes unknown until it reconnects. The dot reports availability; installation remains an explicit action.
~~~

MODIFY the existing sibling pages at:

- docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/reference/management-api.md
- docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/guides/desktop-app.md

For each management API sibling, replace its existing commit-1 GET /api/update/badge row (which already says missing, wrong-channel or 40-hour-old cache returns `unknown: true`) with translations of the two English rows above. Add the 32-session/180-second paragraph after the table but before the existing translated automatic-check paragraph; preserve each sibling's async check/run rows. Keep literal route paths, surface=desktop, session=<id>, status numbers, admin-token, unknown and 1 KiB unchanged. For each desktop guide sibling, insert a translation of the five English sentences above in its existing Updates section. Say explicitly that Linux shows a dot only with a tray host, an ordinary browser sees package state, expiry yields unknown, and installation is explicit. Do not claim the commit-3 update page exists yet. These seven locales are the exact existing siblings found in docs-site/src/content/docs; there are no de/vi guide siblings. English remains the source of truth.

No GUI i18n catalog edits: no new visible string is introduced in commit 2. The existing sidebar.updateAvailable and sidebar.checkUpdate keys already cover the label (gui/src/components/sidebar-github-row.tsx:137-141); the ten catalogs named earlier stay unchanged. Commit 3 adds localized update-page copy.

## Ratchets and merge-head check

The 2026-09-24 HEAD b429895f4a counts below are physical lines before B. `tests/fixtures/file-size-baseline.json` has no explicit cap for any row here. The scanned-file default is **strictly under 2,000**, so the last allowed count is 1,999 and headroom is `1,999 − current`; `structure/manifest.json` independently caps structure pages at 600. New files show 0 before creation. Recount if HEAD moves. `devlog/` is excluded from the file-size ratchet. Rust, Swift and PNG are outside its scanned extensions. The replacement at `structure/runtime.md:159` must be one line for one line.

| Growing path | Current | Last allowed | Headroom |
| --- | ---: | ---: | ---: |
| `src/update/badge.ts` | 67 | 1999 | 1932 |
| `src/update/desktop-badge.ts` | 0 | 1999 | 1999 |
| `src/server/management/sidebar-routes.ts` | 106 | 1999 | 1893 |
| `src/server/management/route-registry.ts` | 395 | 1999 | 1604 |
| `desktop/scripts/generate-icons.ts` | 178 | 1999 | 1821 |
| `gui/src/lib/desktop-shell.ts` | 32 | 1999 | 1967 |
| `gui/src/components/sidebar-github-row.tsx` | 161 | 1999 | 1838 |
| `gui/tests/desktop-shell.test.ts` | 37 | 1999 | 1962 |
| `tests/update/update-desktop-badge.test.ts` | 0 | 1999 | 1999 |
| `tests/server/sidebar-routes.test.ts` | 327 | 1999 | 1672 |
| `tests/server/management-route-registry.test.ts` | 274 | 1999 | 1725 |
| `tests/cli/cli-capabilities.test.ts` | 372 | 1999 | 1627 |
| `tests/ci-workflows/build-desktop-icon-set.test.ts` | 251 | 1999 | 1748 |
| `scripts/test-layout/layout.json` | 1816 | 1999 | 183 |
| `tests/fixtures/test-layout-expected.json` | 1622 | 1999 | 377 |
| `structure/runtime.md` | 600 | 600 | 0 |
| `structure/ops/service-and-sidecars.md` | 254 | 600 | 346 |
| `structure/desktop-shell.md` | 388 | 600 | 212 |
| `structure/companion.md` | 77 | 600 | 523 |
| `structure/gui-and-management-api.md` | 395 | 600 | 205 |
| `docs-site/src/content/docs/reference/management-api.md` | 651 | 1999 | 1348 |
| `docs-site/src/content/docs/guides/desktop-app.md` | 122 | 1999 | 1877 |
| `docs-site/src/content/docs/fr/reference/management-api.md` | 406 | 1999 | 1593 |
| `docs-site/src/content/docs/fr/guides/desktop-app.md` | 79 | 1999 | 1920 |
| `docs-site/src/content/docs/ja/reference/management-api.md` | 348 | 1999 | 1651 |
| `docs-site/src/content/docs/ja/guides/desktop-app.md` | 79 | 1999 | 1920 |
| `docs-site/src/content/docs/ko/reference/management-api.md` | 374 | 1999 | 1625 |
| `docs-site/src/content/docs/ko/guides/desktop-app.md` | 79 | 1999 | 1920 |
| `docs-site/src/content/docs/ru/reference/management-api.md` | 396 | 1999 | 1603 |
| `docs-site/src/content/docs/ru/guides/desktop-app.md` | 124 | 1999 | 1875 |
| `docs-site/src/content/docs/tr/reference/management-api.md` | 432 | 1999 | 1567 |
| `docs-site/src/content/docs/tr/guides/desktop-app.md` | 79 | 1999 | 1920 |
| `docs-site/src/content/docs/zh-cn/reference/management-api.md` | 342 | 1999 | 1657 |
| `docs-site/src/content/docs/zh-cn/guides/desktop-app.md` | 79 | 1999 | 1920 |
| `docs-site/src/content/docs/zh-tw/reference/management-api.md` | 324 | 1999 | 1675 |
| `docs-site/src/content/docs/zh-tw/guides/desktop-app.md` | 79 | 1999 | 1920 |

Outside the scanned extensions: `desktop/src-tauri/src/proxy.rs` 277, `updater.rs` 144, `lib.rs` 288, `startup.rs` 2161, `native_tray.rs` 273, `tray.rs` 620, `popup.rs` 390; `app/Sources/NativeTray/Popover.swift` 68; generated `desktop/src-tauri/icons/tray/icon-update.png` is binary. Their file-size-ratchet headroom is N/A.

## Verifiers — PLAN-VERIFIER-REAL-01

The commands below record the earlier *pre-B* runs on 2026-09-24 after root and GUI dependencies were installed; they are historical baseline evidence, not reruns against commit 1. This plan is now tracked in the shared worktree. The existing source tests do not read it except for the explicit transpiler command shown below. The privacy scanner uses git ls-files (scripts/privacy-scan.ts:60-69), so a fresh B run will include this tracked plan. `structure:check` reads `structure/` and its index, not this plan. The commands prove only the stated earlier baseline, not the future implementation.

| Command, exact working directory | Exit | What ran / reads this plan? |
| --- | --- | --- |
| bun test tests/server/sidebar-routes.test.ts tests/server/management-route-registry.test.ts tests/ci-workflows/build-desktop-icon-set.test.ts tests/cli/cli-capabilities.test.ts (repository root) | 0 | 52 pass, 0 fail across four files; existing source only, no plan read. |
| bun test tests/test-layout-tooling.test.ts (repository root) | 0 | 16 pass, 0 fail; reads existing layout JSON and fixture, not the plan. |
| bun test tests/desktop-shell.test.ts (gui/) | 0 | 3 pass, 0 fail; reads existing GUI helper, not the plan. |
| bun -e 'const text = require("node:fs").readFileSync("devlog/_plan/260924_update_indicator/020_phase2_desktop_state_icons.md", "utf8"); const transpiler = new Bun.Transpiler({ loader: "ts" }); for (const marker of ["### New src/update/desktop-badge.ts", "NEW tests/update/update-desktop-badge.test.ts"]) { const part = text.slice(text.indexOf(marker)); const match = part.match(/~~~ts\n([\s\S]*?)\n~~~/); if (!match) throw new Error("missing " + marker); transpiler.transformSync(match[1]); } console.log("2 complete new TypeScript blocks parse");' (repository root) | 0 | Both complete new TypeScript blocks parsed; this command reads this plan directly. It is syntax evidence, not typechecking or behavior. |
| bun run icons:check (desktop/) | 0 | 18 generated icons match existing source; reads icon generator/assets, not the plan. The earlier trial spelling bun --cwd desktop run icons:check printed Bun usage with exit 0 and was not treated as a verifier. |
| cargo test --manifest-path desktop/src-tauri/Cargo.toml (repository root) | 101 | The earlier run stopped before Rust tests because binaries/ocx-aarch64-apple-darwin was absent. This is environment setup, not a Rust test result. CI prepares an empty host-triple placeholder; B must do the same locally before retesting. |
| swift -e 'import AppKit; let b = NSStatusBarButton(); print(b.cell?.imageRect(forBounds: b.bounds) as Any)' (repository root) | 0 | Confirmed the existing AppKit imageRect API resolves; this is not an overlay visual test and does not read plan. |
| swift -e 'import AppKit; @MainActor enum Dot { static weak var button: NSStatusBarButton? }; @MainActor final class DotView: NSView { override func hitTest(_ point: NSPoint) -> NSView? { nil }; override func draw(_ dirtyRect: NSRect) { let b = NSStatusBarButton(); let r = b.cell?.imageRect(forBounds: b.bounds) ?? b.bounds; print(r.isEmpty) } }' (repository root) | 0 | Type-checked the proposed weak/button, hit-test and image-rect call shapes; it does not render the overlay or read plan. |
| bun run privacy:scan (repository root) | 0 | Earlier tracked-file scan passed; this plan was untracked then, so the result did not cover it. Re-run in B now that the plan is tracked. |
| bun run structure:check (repository root) | 0 | Structure SSOT checks passed on current docs; does not read plan or future source. |
| bun run typecheck (repository root) | 0 | Existing TypeScript compiled with no diagnostics; no proposed source exists yet. Required again after B. |

For local desktop Cargo tests, mirror `.github/workflows/ci.yml:1399-1415`: derive `triple` from `rustc -vV`, create `desktop/src-tauri/binaries/ocx-${triple}` as an empty executable placeholder, and create the ignored GUI resource placeholder if the Tauri build needs it. `.gitignore:85-86` ignores `desktop/src-tauri/binaries/` and `desktop/src-tauri/resources/`; B must not commit these test prerequisites. The empty file is for compilation/tests, not a runnable sidecar.

Runs after B because the new implementation and test files do not exist today: bun test tests/update/update-desktop-badge.test.ts tests/server/sidebar-routes.test.ts tests/server/management-route-registry.test.ts tests/cli/cli-capabilities.test.ts tests/ci-workflows/build-desktop-icon-set.test.ts; bun test tests/test-layout-tooling.test.ts; cd gui && bun test tests/desktop-shell.test.ts && bun run lint && bun run build; cd desktop && bun run icons:check; cargo test --manifest-path desktop/src-tauri/Cargo.toml after making the same ignored empty host-triple sidecar placeholder as CI; bun run typecheck; bun run structure:check; bun run privacy:scan after staging any new B files; cd docs-site && bun install --frozen-lockfile && bun run build. These are future B/C gates, not pass claims. Host CI must be inspected at the final PR head; Windows and Linux Tauri builds and native visual QA remain distinct evidence.

## Risks and rollback

The in-memory snapshot is cosmetic and forged only by a process already holding the raw management token. It cannot invoke the package update job or weaken Tauri signature verification. A proxy restart, shell death, port rebind, missed heartbeat, or >32 active shells makes the affected desktop badge unknown rather than borrowing another session's state. A 60 s poll/heartbeat with 180 s expiry leaves two missed intervals before expiry. The 1 KiB streamed ingress bound and strict six-field allowlist prevent an oversized or nested payload from being retained or logged.

The macOS overlay must be checked against changing title width, AppKit highlight, multiple displays and 1×/2× scaling. Windows and Linux generated icons need visual checking on their hosts; this Mac can validate image generation and Rust logic but cannot claim their rendered tray pixels. Linux without an AppIndicator host still has the embedded badge and no tray icon. If this commit must be backed out before commit 3, revert commit 2 as one unit: the default package badge and original template/PNG tray behavior resume, and no persisted desktop schema needs migration. Do not roll back the independent commit-1 package cache change.

Cross-document handoff for main: structure/INDEX.md maps src/update/ to both runtime.md and ops/service-and-sidecars.md, so commit 2 edits both despite the abbreviated D7 row in 000_plan.md. The binding main decision is net-zero for runtime.md at its 600/600 structure budget: use the one-line replacement above, and coordinate any commit-1 or commit-4 replacements on their final merged text. Commit 3 must consume `CheckGeneration::{begin_if_not_installing,claim_install,apply_if_current,epoch_is_current,inspect}`, extend the UI projection for install state, put its install-epoch comparison inside the application closure, and return an explicit checking page status while a newer check remains active. No D1/D2/D3 disposition changes. Commit 3 still owns the desktop update click before the PR is marked ready.


## wp2 P revalidation

Revalidated against HEAD `b429895f4a` after commit 1; only this 020 plan was edited. Drifts and fixes:

- `src/update/badge.ts`: the header and type moved from the former lines 19-29 to 6-18/12, and commit 1 added `UpdateBadgeDeps.now` plus the 40-hour unknown guard. The type-only replacement above uses the exact current installer declaration and leaves package cache semantics intact. The desktop projection keeps all seven `UpdateBadge` fields and uses its own heartbeat receipt TTL.
- `src/update/index.ts` and `src/server/management/context.ts`: `defaultUpdateTag` now starts at 176, and `ManagementContext.principal` is at 151 after new package-check deps imports. The opening anchors were corrected; neither API shape forces a desktop design change.
- `tests/server/sidebar-routes.test.ts`: commit 1 added the read-only package badge test, moving `call()` to 23-38 and the GET badge describe end to 139. The helper and new describe insertion points now target those exact boundaries and preserve the package test.
- `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`: new update-async and update-refresh entries shifted the alphabetical insertion anchors to 1655-1659 and 1481-1485. The three-line before/after windows above still match HEAD and insert `update-desktop-badge.test.ts` between `update-bun-ownership-lease` and `update-desktop-owner` in both maps.
- `structure/runtime.md`: commit 1 replaced the 600/600 Support row with a package-refresh link. The revised exact before/after block preserves that link and replaces one line with one line. `structure/ops/service-and-sidecars.md` gained a Package cache refresh section at 250-254; the desktop paragraph now appends there, preserving scheduler and async-check contracts.
- `structure/gui-and-management-api.md`: the Updates row now specifies asynchronous check/run and package-cache age. Its revised replacement changes only the final sentence; the Sidebar row replacement uses the current row as its before text.
- English and seven translated `docs-site` management API pages: commit 1 expanded the package badge row and added automatic-check paragraphs, and changed the check/run rows. The English exact-before row, the two replacement rows, and the sibling instructions now preserve those facts and insert the desktop paragraph before the existing automatic-check paragraph.
- Ratchets: the old pre-wp1 counts were stale for the changed package badge, route test, layout maps, ops structure page, and all management API pages. The per-file current count/last-allowed/headroom table above is recalculated from HEAD and the baseline. `structure/runtime.md` has zero spare lines.
- Desktop Cargo prerequisite: CI already creates an empty executable `ocx-${triple}` and GUI resource placeholder before `cargo test` (`.github/workflows/ci.yml:1399-1415`). B will prepare the same ignored local placeholders without committing them; `.gitignore:85-86` covers both directories.

Fresh P checks: exact HEAD before-anchor assertions passed for the package badge, structure rows, layout neighbors, and all eight management API pages; all 36 headroom rows matched current file counts and absent baseline caps; both complete proposed TypeScript blocks parsed; `git diff --check` passed. These checks validate this plan, not the unimplemented B behavior.

No D1/D2/D3 design decision changes.
