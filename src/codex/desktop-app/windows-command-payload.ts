const PAYLOAD_ENV = "OPENCODEX_DESKTOP_COMMAND_PAYLOAD";

// Keep package paths and other dynamic inputs out of the PowerShell parser.
export const READ_WINDOWS_DESKTOP_PAYLOAD =
  `$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${PAYLOAD_ENV})) | ConvertFrom-Json`;

export function windowsDesktopPayloadEnv(payload: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, [PAYLOAD_ENV]: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") };
}
