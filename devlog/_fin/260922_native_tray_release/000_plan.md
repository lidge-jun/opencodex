# Native macOS tray and release verification

The macOS usage popup currently embeds a web page whose clipping and scrolling disagree with its native window. Replace that popup with an AppKit popover hosting SwiftUI, keeping one application and the existing runtime owner. Preserve the dashboard and Windows/Linux popup. Review and test the changes since v2.59.0 before publishing stable and preview releases.

## Loop contract

- Archetype: satisfy-spec, sequential full PABCD cycles.
- Trigger: user-reproduced blocked scrolling and square outer corners over other windows; explicit request for native macOS UI and both release channels.
- Goal: native popup parity, verified regressions, signed installed app, stable main and preview publications.
- Non-goals: replacing the full dashboard, adding another app/runtime owner, changing accounts/configuration, weakening signing or protected branches.
- Verifiers: native model executable, Rust focused/full tests, GUI build and relevant tests, root typecheck/full test, privacy/structure gates, real installed app interaction, exact-head hosted CI and release receipts. Each implementation phase records actual command availability and target coverage before use.
- Stop: all work phases and recorded acceptance criteria complete, with exact release and installed artifact identities.
- Artifacts: this numbered unit; private/raw test results in `.tmp/native-tray-design/` and `.codexclaw/evidence/`; only sanitized evidence committed.
- Outcomes: DONE requires real proof; report missing external permissions/access or unsafe publication honestly; never reinterpret skipped/cancelled checks as success.
- Escalation: concrete credential/access blockers or incompatible requested behavior; new defects append a planned cycle without shrinking verification.
- Resources: no user-imposed token/cost or wall-clock cap; commands run as managed background processes with bounded polls. One release workflow at a time.
- Authority: user authorized implementation, verification and BOTH main stable and preview deployment. At 09:40 the user superseded Sol parallelism: closed all children, main implements and reviews directly, one PABCD cycle at a time. No further delegation; independent-agent consultation/review is therefore NOT RUN, not claimed.

## Dependency order

| Cycle | Design | Delivered outcome |
|---|---|---|
| wp0 | this roadmap and `001_evidence.md` | reviewed docs-only roadmap; no production patch |
| wp1 | `010_native_presentation.md` | versioned native DTO/model and SwiftUI content, model regression tests |
| wp2 | `020_shell_integration.md` | same-process AppKit popover, Rust transport/events, build and signing integration |
| wp3 | `030_regression.md` | v2.59.0-to-final diff audit, concrete repairs, local/native/hosted test and UI evidence |
| wp4 | `040_release.md` | dev integration, main/preview promotion, published artifacts and local install verified |

Source layout: `app/Sources/NativeTray/` owns native presentation; `desktop/src-tauri/src/native_tray*.rs` owns transport and bridge; existing `proxy.rs` owns authenticated runtime requests; `tray.rs` remains the one icon/menu owner. Structure authorities are `structure/desktop-shell.md` and `structure/gui-and-management-api.md`. No new server endpoint.

## Review decisions

A1: link a Swift static library into the existing Rust process. Reject a second Swift app/helper because it duplicates lifecycle, icon and signing ownership. A scratch Rust-to-Swift link probe passed on this host.
A2: use the pinned Tauri `with_inner_tray_icon` / tray-icon `ns_status_item()` seam to anchor `NSPopover` to the real `NSStatusBarButton`; no transparent auxiliary window.
A3: retain Rust `ProxyClient` as the only authenticated network owner; Swift receives a versioned, whitelisted display DTO and emits a small callback event enum. Reject raw config/token delivery to Swift and independent Swift networking.
A4: keep Windows/Linux web popup and all main-window/runtime/update paths. macOS dispatch changes only the usage-popup branch.
A5: AppKit owns popup geometry, material, dismissal and outer corners. SwiftUI owns a bounded ScrollView and content; no CSS/native double backgrounds.
A6: user no-delegation steering overrides architect/reviewer dispatch requirements. Main performs explicit plan and adversarial code review in separate passes, recording the lack of independent reviewer.

## Cycle record

P wp0: requirements and source evidence collected, scratch FFI link passed, full phase map written. No production source changed.

B wp0: roadmap locked after main-direct review; all four implementation/delivery decade docs populated. The latest user instruction supersedes prior parallel-agent plans. Next cycle implements only native presentation foundations.

C/D wp0: reviewed the roadmap as an executable sequence; staged-document whitespace check passed. This cycle fixes no runtime behavior and makes no regression claim. The main risk remains real native integration, so wp1 must prove SwiftUI/framework linking and model semantics before wp2 can activate it. Continue with wp1 as written; no scope/criterion reduction.

C/D wp1: native presentation and ABI foundation compiled for macOS 13, SwiftUI/Charts/AppKit linked into Rust, 26 model assertions passed, and a real native fixture reached provider 40 by scrolling while retaining header/footer. Apple Liquid Glass requirement is implemented with the system view on supported SDK/OS; actual anchored/background composition remains wp2. Evidence and limitations: `011_presentation_verification.md`. Continue wp2; no full-app or release claim yet.

Latest user steering: main remains the implementer; Sol read-only verifiers are now required for each PABCD design/implementation verification. This supersedes the earlier blanket no-delegation instruction for verification only. Current wp2 has a Sol verifier; future cycles retain that role. Earlier wp0/wp1 remain honestly recorded as main-reviewed under the instruction in force then; Sol will review their inherited design/code before wp2 closes.
