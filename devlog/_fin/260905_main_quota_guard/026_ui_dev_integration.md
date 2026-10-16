# UI integration with current quota controls

UI rebased onto runtime03ee2f119/latest dev593978db0. Union conflict resolution preserves the quotaAutoRefresh DTO/control props and the independent hard-lock status/Manage/navigation wiring. Aristotle read-only union review found no missing wiring; its fixture update supplies the new required quotaAutoRefresh fields/props without changing assertions.

GUI build/typecheck passed. No local test suite ran. Isolated real-component browser inspection at1280x900 and390x844 verified no horizontal overflow, coexistence of the new automatic-window controls and hard-lock status, confirmation/save with toggle focus restoration, and Manage focus/scroll to the peer-level setting beneath Ultra Fast. Captured three new JPEGs in022_ui_evidence with integrated in the filenames; prior screenshots remain historical evidence.

The preview used fake quota/account data, separate homes and ports15141/15142, and an explicit outbound-fetch refusal. Automatic-window switches remained off; no model warmup, real account change or live10100 mutation occurred. Viewport/CDP overrides, tab and preview processes were cleaned up. Fresh exact-head CI and maintainer review remain required after publication.
