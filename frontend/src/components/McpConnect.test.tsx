import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { McpConnect } from './McpConnect';
import { api } from '../api';

const toast = vi.fn();
vi.mock('../AppContext', () => ({ useToast: () => toast }));
vi.mock('../api', () => ({
  api: {
    getMcpInfo: vi.fn(async () => ({ endpoint: 'https://seo.test/mcp', transport: 'http', scopes: [] })),
    getMcpTokens: vi.fn(async () => []),
    getOAuthClients: vi.fn(async () => []),
    getConnectedApps: vi.fn(),
    updateConnectedApp: vi.fn(async (_id: string, scopes: string[]) => ({ ok: true, scopes })),
    revokeConnectedApp: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(api.getConnectedApps).mockResolvedValue([{ id: 'g1', client_name: 'Claude', scopes: ['mcp:read'], created_at: '2026-10-20T10:00:00Z', last_used_at: null }]);
});

it('gives a connected app more access without reconnecting it', async () => {
  render(<McpConnect compact />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change access' }));
  const group = screen.getByRole('group', { name: 'Access for Claude' });
  const reviews = Array.from(group.querySelectorAll('label')).find(l => l.textContent?.includes('Business Profile changes'))!.querySelector('input')!;
  fireEvent.click(reviews);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateConnectedApp).toHaveBeenCalledWith('g1', ['mcp:read', 'reviews:write']));
  expect(toast).toHaveBeenCalledWith('success', expect.stringMatching(/Start a new chat in Claude/));
});
