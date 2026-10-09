export const DESKTOP_CLI_RECORD_MAX_BYTES: number;
export type DesktopCliRecord = Readonly<{
  platform: "darwin" | "win32" | "linux";
  kind: "macos-app" | "windows-install" | "linux-deb";
  cliExecutable: string;
}>;
export type DesktopCliRecordIssue = "record-invalid" | "record-too-large" | "record-pending" | "record-unreadable";
export type DesktopCliRecordRead =
  | { state: "missing"; path: string }
  | { state: "disabled"; path: string; cleanupPending: boolean }
  | { state: "ready"; path: string; record: DesktopCliRecord }
  | { state: "invalid" | "unreadable"; path: string; issue: DesktopCliRecordIssue };
export type DesktopCliRecordOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  recordPath?: string;
};
export function desktopCliRecordPath(options?: DesktopCliRecordOptions): string;
export function readDesktopCliRecord(options?: DesktopCliRecordOptions): DesktopCliRecordRead;
