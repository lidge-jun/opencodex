export function validProfileName(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(name) && name !== "default";
}
