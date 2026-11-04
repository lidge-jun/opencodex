import { installWindowsLinkCreateEmulation } from "./windows-link-create-emulation";

// Preload for test workers: on Windows the platform already behaves this way.
if (process.platform !== "win32") installWindowsLinkCreateEmulation();
