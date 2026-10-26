import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openGoogleWindow } from './googleConnect';

// Browsers only allow a pop-up opened by the click itself. The window must open
// before anything is awaited, then be pointed at Google; if it can't open, the
// sign-in carries on in this tab.
const assign = vi.fn();
let original: Location;

beforeEach(() => {
  original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign, pathname: '/ads', search: '?tab=setup' } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: original });
  vi.restoreAllMocks();
  assign.mockReset();
});

it('opens the window during the click, then loads Google into it', async () => {
  const popup = { closed: false, location: { href: '' }, focus: vi.fn(), close: vi.fn(), document: document.implementation.createHTMLDocument('') };
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  let resolveUrl!: (url: string) => void;
  const pending = openGoogleWindow('google-auth', () => new Promise<string>(r => { resolveUrl = r; }));
  // Opened synchronously, before the server has answered.
  expect(open).toHaveBeenCalledWith('', 'google-auth', expect.any(String));
  expect(popup.document.body.textContent).toContain('Opening Google');
  resolveUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1');
  expect(await pending).toBe('popup');
  expect(popup.location.href).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
  expect(assign).not.toHaveBeenCalled();
});

it('continues in this tab when pop-ups are blocked', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  expect(await openGoogleWindow('google-auth', async () => 'https://accounts.google.com/o/oauth2/v2/auth?y=2')).toBe('redirect');
  expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?y=2');
});

it('closes the empty window if the server refuses', async () => {
  const popup = { closed: false, location: { href: '' }, focus: vi.fn(), close: vi.fn(), document: document.implementation.createHTMLDocument('') };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  await expect(openGoogleWindow('google-auth', async () => { throw new Error('No active workspace.'); })).rejects.toThrow('No active workspace.');
  expect(popup.close).toHaveBeenCalled();
});
