import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { GoogleConnectForm } from './GoogleConnectForm';
import { apiFetch } from '../api/client';
import { openGoogleConsent } from '../ads/googleConnect';

const toast = vi.fn();
vi.mock('../AppContext', () => ({ useToast: () => toast }));
vi.mock('../ads/googleConnect', () => ({ openGoogleConsent: vi.fn(async () => 'popup'), useGoogleAuthSuccess: () => {} }));
vi.mock('../api/client', () => ({ apiFetch: vi.fn() }));

const savedProject = { project: '222222222222', source_id: 'client:c1', builtin: false, saved_client_id: 'c1', label: 'Ads – Basic access', connections: [] };
let projects: unknown[] = [];

beforeEach(() => {
  projects = [];
  vi.mocked(openGoogleConsent).mockClear();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/google/projects') return { builtin_available: false, projects };
    if (url === '/api/auth/google/clients' && init?.method === 'POST') { projects = [savedProject]; return { id: 'c1' }; }
    if (url.startsWith('/api/auth/google/clients/') && init?.method === 'DELETE') { projects = []; return { ok: true }; }
    return {};
  });
});

it('saves a newly entered OAuth client for later and selects it', async () => {
  render(<GoogleConnectForm product="ads" canManage />);
  fireEvent.change(await screen.findByPlaceholderText(/apps\.googleusercontent\.com/), { target: { value: '222222222222-abc.apps.googleusercontent.com' } });
  fireEvent.change(screen.getByPlaceholderText('GOCSPX-…'), { target: { value: 'GOCSPX-secret' } });
  fireEvent.change(screen.getByPlaceholderText(/Basic access/), { target: { value: 'Ads – Basic access' } });
  fireEvent.click(screen.getByRole('button', { name: /Save project for later/ }));
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('existing:client:c1'));
  const post = vi.mocked(apiFetch).mock.calls.find(([url, init]) => url === '/api/auth/google/clients' && init?.method === 'POST')!;
  expect(JSON.parse(String(post[1]!.body))).toEqual({ clientId: '222222222222-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', label: 'Ads – Basic access' });
  expect(screen.getByRole('option', { name: /Ads – Basic access — Project 222222222222: saved, nobody signed in yet/ })).toBeTruthy();
  expect(screen.queryByPlaceholderText('GOCSPX-…')).toBeNull();
});

it('signs in through a saved project without re-entering anything, and can forget it', async () => {
  projects = [savedProject];
  render(<GoogleConnectForm product="business" canManage />);
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('existing:client:c1'));
  fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/ }));
  await waitFor(() => expect(openGoogleConsent).toHaveBeenCalledWith(expect.objectContaining({ projectFrom: 'client:c1', business: true })));
  expect(vi.mocked(openGoogleConsent).mock.calls[0][0]).not.toHaveProperty('clientSecret');

  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: /Forget this saved project/ }));
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/auth/google/clients/c1', { method: 'DELETE' }));
});
