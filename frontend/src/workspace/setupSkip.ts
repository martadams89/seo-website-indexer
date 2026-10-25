// Remember, per workspace and per browser, that the person chose to leave the
// Google setup wizard, so an empty workspace stops redirecting them into it.
// The sidebar's "Setup required" link still leads back.
const key = (workspaceId: string) => `setup-skipped:${workspaceId}`;

export function isSetupSkipped(workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return false;
  try { return localStorage.getItem(key(workspaceId)) === '1'; } catch { return false; }
}

export function skipSetup(workspaceId: string | null | undefined): void {
  if (!workspaceId) return;
  try { localStorage.setItem(key(workspaceId), '1'); } catch { /* storage unavailable: the redirect simply comes back */ }
}
