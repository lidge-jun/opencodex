# UI review and rendered feedback

Rendered correction: main-card policy text initially touched the card edge. Align it with the existing16px card inset and place the manage action in a wrapping row with an adequate target. No global tokens changed.

Independent reviewer Descartes found one accepted lifecycle blocker: a delayed PUT for proxyA can invoke its captured onSaved after apiBase changes toB, allowing old load(A) to advance the reused controller generation and replace B's displayed accounts.
RCA: keying only the setting protects its local state, not the parent-owned callback/controller. Bind the parent controller and completion callback to its proxy lifetime, while still allowing refresh after Advanced collapses within the same proxy. Add a deferred-PUT A->B regression that verifies B's account/status remains authoritative and no late old-proxy reload wins. Do not suppress the existing same-proxy collapsed-save refresh.

Existing source review accepted acknowledgment, cancellation, error distinctions, main-card recovery, copy in9locales and state priority. Browser already observed Escape cancellation with0PUT, one confirmed save with1PUT, policy block hiding main activation, and a fresh0 usage update returning monitoring while the switch stays enabled. These are fixture-backed real-component observations, not live account changes.

The lifecycle blocker is closed by keyed parent ownership plus retiring callbacks on unmount; same-proxy Advanced collapse retains its soft reload. Reviewer Descartes returned PASS on the repair and both regressions.
Rendered mobile feedback: keep Korean words together and use44px confirmation targets. The embedded browser could move keyboard focus out of the native dialog at the two-button boundary; explicitly wrap Tab/Shift-Tab between Cancel and Confirm. No background page control becomes a focus target. Browser capture initially inherited80% zoom; device emulation was used to verify exact390/768/1280 CSS widths, and temporary emulation will be cleared at teardown.

UI CI React Doctor atfba57fcc1 flagged anchor-target-exists for the fallback href=#codex-set. This is a real application hash route, not an in-document anchor; use the existing navigateHash button convention to express that intent without a scanner suppression. Preserve the same-page callback. Artifact integrity also found native JPEG screenshot bytes with .png suffixes; rename to .jpg without altering/re-encoding any image content.
