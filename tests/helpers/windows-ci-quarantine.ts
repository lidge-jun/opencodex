// Temporary 2.98.0 quarantine: https://github.com/lidge-jun/opencodex/issues/8262
export const hostedWindowsQuarantine = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true";
