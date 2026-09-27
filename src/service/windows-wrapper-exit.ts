// Only wrappers advertising this protocol understand a nonzero intentional exit.
export const WINDOWS_WRAPPER_PROTOCOL_ENV = "OCX_WINDOWS_WRAPPER_PROTOCOL";
export const WINDOWS_WRAPPER_STAY_OUT_EXIT_CODE = 42;

export function serviceStayOutExitCode(env: NodeJS.ProcessEnv = process.env): number {
  return env.OCX_SERVICE === "1" && env[WINDOWS_WRAPPER_PROTOCOL_ENV] === "1"
    ? WINDOWS_WRAPPER_STAY_OUT_EXIT_CODE : 0;
}
