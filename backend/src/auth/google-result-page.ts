/**
 * auth/google-result-page.ts — the page Google's sign-in callback renders.
 */

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** JSON that is safe inside an inline <script>. */
export const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * The page Google's sign-in lands on. In a pop-up it tells the dashboard what
 * happened and closes; when the sign-in ran in the same tab (pop-ups
 * blocked), it goes back to where the person started.
 */
export function googleResultPage(opts: {
  ok: boolean; title: string; message: string; post: Record<string, unknown> | null; openerOrigin: string | null; returnTo: string | null; autoClose?: boolean;
}): string {
  const back = opts.returnTo ?? '/settings?tab=google';
  return `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(opts.title)}</title></head>
  <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #12131a; color: #e2e8f0; padding: 40px 16px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh;">
    <div style="font-size: 48px; margin-bottom: 20px;">${opts.ok ? '✅' : '⚠️'}</div>
    <h2 style="color: white; margin-bottom: 8px;">${escapeHtml(opts.title)}</h2>
    <p style="color: #94a3b8; font-size: 14px; max-width: 560px; line-height: 1.5;">${escapeHtml(opts.message)}</p>
    <p id="actions" style="margin-top: 16px;">
      <button id="close" onclick="window.close()" style="display: none; background: #252836; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold;">Close</button>
      <a id="back" href="${escapeHtml(back)}" style="display: none; background: #252836; color: white; padding: 10px 20px; border-radius: 6px; font-weight: bold; text-decoration: none;">Back to the dashboard</a>
    </p>
    <script>
      if (window.opener) {
        document.getElementById('close').style.display = 'inline-block';
        ${opts.post && opts.openerOrigin ? `window.opener.postMessage(${scriptJson(opts.post)}, ${scriptJson(opts.openerOrigin)});` : ''}
        ${opts.autoClose ? 'setTimeout(function () { window.close(); }, 1500);' : ''}
      } else {
        document.getElementById('back').style.display = 'inline-block';
        ${opts.ok ? `setTimeout(function () { window.location.replace(${scriptJson(back)}); }, 1500);` : ''}
      }
    </script>
  </body>
</html>`;
}
