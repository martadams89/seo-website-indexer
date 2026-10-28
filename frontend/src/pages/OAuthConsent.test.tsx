import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OAuthConsentPage from './OAuthConsent';
import { api } from '../api';

vi.mock('../api', () => ({ api: { getOAuthRequest: vi.fn(), decideOAuthRequest: vi.fn() } }));

const request = {
  id: 'req1', client_name: 'Claude', client_domain: 'claude.ai', redirect_host: 'claude.ai', requested_scopes: ['mcp:read', 'ads:write'],
  previously_granted: null as string[] | null,
  scopes: [
    { id: 'mcp:read', label: 'Read your data', description: 'Read' },
    { id: 'ads:write', label: 'Manage Google Ads', description: 'Ads' },
    { id: 'reviews:write', label: 'Manage Google Business Profile', description: 'GBP' },
  ],
  user: { email: 'me@example.com', name: null }, workspaces: ['Acme'],
};

const assign = vi.fn();
const open = () => render(<MemoryRouter initialEntries={['/oauth/consent?request=req1']}><OAuthConsentPage /></MemoryRouter>);

beforeEach(() => {
  vi.mocked(api.getOAuthRequest).mockReset();
  vi.mocked(api.decideOAuthRequest).mockReset().mockResolvedValue({ redirect: 'https://claude.ai/api/mcp/auth_callback?code=abc' });
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

it('asks a person to choose access the first time an app connects', async () => {
  vi.mocked(api.getOAuthRequest).mockResolvedValue(request);
  open();
  fireEvent.click(await screen.findByRole('button', { name: /Allow access/ }));
  await waitFor(() => expect(api.decideOAuthRequest).toHaveBeenCalledWith('req1', true, ['mcp:read', 'ads:write']));
  expect(assign).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?code=abc');
});

it('sends an app that is already connected straight back with the access it had', async () => {
  vi.mocked(api.getOAuthRequest).mockResolvedValue({ ...request, previously_granted: ['mcp:read', 'reviews:write'] });
  open();
  expect(await screen.findByText(/Reconnecting Claude/)).toBeTruthy();
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?code=abc'));
  expect(api.decideOAuthRequest).toHaveBeenCalledWith('req1', true, ['mcp:read', 'reviews:write']);
  expect(screen.queryByRole('button', { name: /Allow access/ })).toBeNull();
});
