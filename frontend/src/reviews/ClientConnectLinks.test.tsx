import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ClientConnectLinks } from './ClientConnectLinks';
import { reviewsApi } from './api';

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
