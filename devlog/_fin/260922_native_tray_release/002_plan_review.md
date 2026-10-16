# Roadmap review and dispositions

Main direct review, required by the user's no-delegation steering; this is not an independent reviewer sign-off.

1. Existing Swift package has macOS 14 minimum for WidgetKit; linking that unchanged as the desktop implementation would accidentally raise the desktop minimum (currently 13). Accepted: the Cargo build compiles the native source set directly with deployment target 13, while SwiftPM tests remain on the available host. Compile availability is an explicit wp1 check.
2. Tray icon must not be duplicated by a new MenuBarExtra scene. Accepted: use the existing NSStatusItem via the pinned public inner-tray seam, all AppKit calls on main thread. Closing the usage popover cannot stop a proxy or exit the app.
3. Raw config/account responses could over-broaden the Swift interface and make testing ambiguous. Accepted: Rust projects an explicit display DTO; no config/credential persistence or network client in Swift.
4. A native implementation cannot claim parity using only provider aggregate quotas. Accepted: enumerate account roster paths, active OpenAI selection and missing data semantics; include mixed partial failure and hidden/model filters in fixtures.
5. A model test does not prove window corner/scroll behavior. Accepted: wp2/w3 explicitly require installed native interactions over both desktop and another window, scroll to footer and back, Escape/outside-click/reopen.
6. Release versions cannot be selected from the user's 2.59.0 reference: current main/preview are 2.60.0. Accepted: preserve v2.59.0 as regression baseline and read live version line before selecting publication versions.
7. Static library feasibility: Rust calls the compiled Swift export successfully. Do not depend on missing swift-autolink-extract. Native view/framework linking remains a wp1 executable check.

No production source has changed. File ownership and dependency order are explicit. New-file method bodies remain implementation detail, bounded by the stated ABI/model contracts and fixtures; any change of contract or file scope must amend the corresponding phase design first.

VERDICT: PASS — sequential roadmap ready; independent architect/reviewer consultation NOT RUN under explicit user instruction.
