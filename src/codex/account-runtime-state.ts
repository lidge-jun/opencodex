const reauthAccounts = new Set<string>();

export function markAccountNeedsReauth(id: string): void {
  reauthAccounts.add(id);
}

export function isAccountNeedsReauth(id: string): boolean {
  return reauthAccounts.has(id);
}

export function clearAccountNeedsReauth(id: string): void {
  reauthAccounts.delete(id);
}
