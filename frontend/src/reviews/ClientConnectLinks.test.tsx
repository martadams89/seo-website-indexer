import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ClientConnectLinks } from './ClientConnectLinks';
import { reviewsApi } from './api';
import { openGoogleConsent } from '../ads/googleConnect';

const auth = vi.hoisted(() => ({ onSuccess: null as null | ((c: { email?: string; accountId?: string }) => void) }));
vi.mock('../ads/googleConnect', () => ({
  openGoogleConsent: vi.fn(async () => 'popup'),
  useGoogleAuthSuccess: (fn: (c: { email?: string; accountId?: string }) => void) => { auth.onSuccess = fn; },
}));
vi.mock('./ReviewsLocations', () => ({
  LinkLocationsModal: ({ googleAccountId, description }: { googleAccountId?: string; description?: string }) => <div role="dialog">{`pick for ${googleAccountId}: ${description}`}</div>,
}));

const toast = vi.fn();
vi.mock('../AppContext', () => ({ useToast: () => toast }));
vi.mock('../workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ active: { id: 'ws1', permissions: { manage_integrations: true } } }) }));
vi.mock('../api/client', () => ({
  apiFetch: vi.fn(async () => ({ builtin_available: false, projects: [
    { project: '111111111111', source_id: 'search@agency.test', builtin: false, label: null, connections: [{ email: 'search@agency.test', limited_to: null, locations: 0 }] },
    { project: '222222222222', source_id: 'martflix@agency.test', builtin: false, label: 'GBP approved', connections: [{ email: 'martflix@agency.test', limited_to: ['business'], locations: 4 }] },
  ] })),
}));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  reviewsApi: { connectInvites: vi.fn(), createConnectInvite: vi.fn(), revokeConnectInvite: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(reviewsApi.connectInvites).mockResolvedValue([]);
  vi.mocked(reviewsApi.createConnectInvite).mockResolvedValue({
    id: 'i1', status: 'open', client_name: 'Bright Smiles', client_email: null, project: '222222222222', google_email: null, shared_locations: [],
    expires_at: '2026-11-02T00:00:00Z', connected_at: null, created_at: '2026-10-26T00:00:00Z', created_by: 'Martin', url: 'https://seo.test/connect/abc', emailed: false,
  });
});

it('defaults to the project already serving Business Profile and creates a link to copy', async () => {
  render(<ClientConnectLinks canManage />);
  const select = await screen.findByLabelText(/Cloud project they sign in through/) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('martflix@agency.test'));
  fireEvent.change(screen.getByPlaceholderText('e.g. Bright Smiles Dental'), { target: { value: 'Bright Smiles' } });
  fireEvent.click(screen.getByRole('button', { name: /Create link/ }));
  await waitFor(() => expect(reviewsApi.createConnectInvite).toHaveBeenCalledWith({ projectFrom: 'martflix@agency.test', clientName: 'Bright Smiles', clientEmail: undefined, days: 7 }));
  expect(await screen.findByText('https://seo.test/connect/abc')).toBeTruthy();
});

it('signs the client in from the dashboard, Business Profile only, then picks their profiles', async () => {
  render(<ClientConnectLinks canManage />);
  const select = await screen.findByLabelText(/Cloud project/) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('martflix@agency.test'));
  fireEvent.click(screen.getByRole('button', { name: /Sign in here/ }));
  expect(screen.queryByPlaceholderText('owner@client.com')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Sign in with the client's Google account/ }));
  await waitFor(() => expect(openGoogleConsent).toHaveBeenCalledWith(expect.objectContaining({ projectFrom: 'martflix@agency.test', only: ['business'], business: true })));
  act(() => auth.onSuccess?.({ accountId: 'owner@client.test~222222222222', email: 'owner@client.test' }));
  expect((await screen.findByRole('dialog')).textContent).toBe('pick for owner@client.test~222222222222: Connected owner@client.test. Choose the profiles to manage in this workspace.');
});

it('ignores sign-ins it did not start', async () => {
  render(<ClientConnectLinks canManage />);
  await screen.findByLabelText(/Cloud project/);
  act(() => auth.onSuccess?.({ accountId: 'someone@else.test', email: 'someone@else.test' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
