# ADR-5494 — decision recorded under "Startup, quit and the tray"

- Contract owner: [desktop-shell.md](../desktop-shell.md#startup-quit-and-the-tray)

## Decision record

- 목적과 의도: Keep a login-started desktop shell ready in the background without paying the full dashboard's render and polling cost before a person opens it.
- 기존 구현 및 제약 조건: The shell already owns a small bundled startup surface, but every successful startup replaced it with the loopback dashboard even when the main window remained hidden behind a usable tray.
- 검토한 주요 대안: Destroy and recreate the WebView on every open; add a second dashboard window; suspend individual dashboard pollers; or retain the existing startup surface until the first explicit open.
- 선택한 방식: A hidden autostart launch stays on the bundled ready surface. Manual launches and any visible no-tray launch keep eager dashboard navigation; tray Open Dashboard, a second ordinary launch, and the shell command lazily navigate before showing.
- 다른 대안 대신 이 방식을 선택한 이유: It removes background React work without adding a window, renderer lifecycle, daemon, or new state owner, and it preserves the already-tested visible startup and failure surface.
- 장점, 단점 및 영향: Background login uses less work and explicit opens remain immediate after one navigation. The first open after hidden startup now pays the dashboard load once, while visible/manual behavior is unchanged.
