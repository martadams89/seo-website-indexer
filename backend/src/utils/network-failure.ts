/**
 * Node's fetch reports every connection problem as a bare "fetch failed".
 * Dig out the underlying cause (DNS, refused, TLS…) and say what to check, so
 * an integration can show something more useful than "fetch failed".
 * Returns null for errors that aren't network failures.
 */
export function describeNetworkFailure(e: unknown, host: string, timeoutSeconds: number): { message: string; hint: string } | null {
  if (!(e instanceof Error)) return null;
  if (e.name === 'TimeoutError') {
    return {
      message: `${host} did not answer within ${timeoutSeconds} seconds.`,
      hint: 'Google may be slow right now — try again in a minute. If it keeps happening, check the server\'s outbound HTTPS connection.',
    };
  }
  if (e.message !== 'fetch failed') return null;
  type Cause = { code?: string; message?: string; errors?: Cause[] };
  const cause = (e as { cause?: Cause }).cause;
  const inner = cause?.code ? cause : cause?.errors?.find(c => c.code) ?? cause;
  const code = inner?.code ?? '';
  const detail = [code, inner?.message && inner.message !== code ? inner.message : ''].filter(Boolean).join(': ');
  const message = `The server couldn't connect to ${host}${detail ? ` (${detail})` : ''}.`;
  let hint = `Check that the server can make outbound HTTPS requests to ${host}.`;
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    hint = `The server's DNS couldn't look up ${host}. Ad-blocking DNS (Pi-hole, AdGuard Home, NextDNS and similar) often blocks Google advertising and business domains — allow ${host} there, then try again.`;
  } else if (/ECONNREFUSED/.test(code)) {
    hint = `The connection was refused. Ad-blocking DNS that answers 0.0.0.0 for Google domains (Pi-hole, AdGuard Home…) or a firewall rule usually causes this — allow ${host}, then try again.`;
  } else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL/i.test(code)) {
    hint = 'Something between the server and Google is intercepting HTTPS (a TLS-inspecting proxy or firewall). Exempt Google\'s APIs from inspection, or trust its certificate with NODE_EXTRA_CA_CERTS.';
  } else if (/TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNRESET/.test(code)) {
    hint = `The connection to ${host} timed out or was cut off. Check the server's firewall and outbound network; if it was a one-off, try again.`;
  }
  return { message, hint };
}
