import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import SetupPage from './Setup';
import { api } from '../api';
import { isSetupSkipped } from '../workspace/setupSkip';

const refresh = vi.fn(async () => {});
const switchWorkspace = vi.fn();

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: {
    getMyAccounts: vi.fn(),
    shareAccountWithWorkspace: vi.fn(async () => ({ ok: true })),
    beginGoogleAuth: vi.fn(),
    getStatus: vi.fn(),
  },
}));
vi.mock('../AppContext', () => ({ useApp: () => ({ status: { auth: { authenticated: false, hasBuiltinCredentials: true } }, refresh }) }));
vi.mock('../workspace/WorkspaceContext', () => ({
  useWorkspace: () => ({
    activeId: 'w2', active: { id: 'w2', name: 'New Client', permissions: { manage_integrations: true } },
    workspaces: [{ id: 'w1', name: 'Agency' }, { id: 'w2', name: 'New Client' }], switchWorkspace,
  }),
}));

function renderSetup() {
  return render(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/" element={<div>Dashboard home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.getMyAccounts).mockResolvedValue([
    { id: 'g1', email: 'me@agency.com', client_id: 'c', created_at: '2026-10-01T00:00:00Z', available_in_workspace: false },
    { id: 'g2', email: 'already@here.com', client_id: 'c', created_at: '2026-09-01T00:00:00Z', available_in_workspace: true },
  ]);
});

it('lets you skip setup, and remembers it for this workspace', () => {
  renderSetup();
  fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
  expect(screen.getByText('Dashboard home')).toBeTruthy();
  expect(isSetupSkipped('w2')).toBe(true);
  expect(isSetupSkipped('w1')).toBe(false);
});

it('reuses a Google account connected in another workspace', async () => {
  renderSetup();
  expect(await screen.findByText('me@agency.com')).toBeTruthy();
  expect(screen.queryByText('already@here.com')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /use in this workspace/i }));
  await waitFor(() => expect(api.shareAccountWithWorkspace).toHaveBeenCalledWith('g1'));
  expect(refresh).toHaveBeenCalled();
  expect(await screen.findByText("You're connected!")).toBeTruthy();
});

it('switches to another workspace from the wizard', () => {
  renderSetup();
  fireEvent.change(screen.getByLabelText('Switch workspace'), { target: { value: 'w1' } });
  expect(switchWorkspace).toHaveBeenCalledWith('w1');
});
