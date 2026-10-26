import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { NotificationsTab } from './NotificationsTab';
import { api } from '../api';

vi.mock('../workspace/WorkspaceContext', () => ({
  useWorkspace: () => ({ active: { id: 'ws1', name: 'Acme', slug: 'acme', permissions: { manage_notifications: true } } }),
}));
vi.mock('../api', () => ({
  api: {
    getNotifyConfig: vi.fn(),
    saveNotifyConfig: vi.fn(async () => ({ ok: true })),
    testNotifications: vi.fn(async () => ({ results: [] })),
    getNotificationDeliveries: vi.fn(async () => []),
  },
}));

beforeEach(() => {
  vi.mocked(api.saveNotifyConfig).mockClear();
  vi.mocked(api.getNotifyConfig).mockResolvedValue({
    notify_slack_webhook: 'https://hooks.slack.com/services/x',
    notify_whatsapp_token: 'EAAG', notify_whatsapp_phone_id: '106540352242922', notify_whatsapp_to: '+44 7700 900123',
    notify_routes: JSON.stringify({ whatsapp: ['review_approvals'] }),
    notify_email_lists: '[]',
  });
});

const lastSaved = () => vi.mocked(api.saveNotifyConfig).mock.calls.at(-1)![0];

it('shows WhatsApp as a channel and which events each channel gets', async () => {
  render(<NotificationsTab />);
  expect(await screen.findByText('Where each event goes')).toBeTruthy();
  expect((screen.getByLabelText('Business Profile approvals to WhatsApp') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Google Ads approvals to WhatsApp') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Google Ads approvals to Slack') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('/w/acme/approve/…')).toBeTruthy();
});

it('saves narrowed routes and drops a channel that gets everything again', async () => {
  render(<NotificationsTab />);
  fireEvent.click(await screen.findByLabelText('Successful runs to Slack'));
  fireEvent.click(screen.getByLabelText('Google Ads approvals to WhatsApp'));
  fireEvent.click(screen.getByRole('button', { name: /Save notifications/ }));
  await waitFor(() => expect(api.saveNotifyConfig).toHaveBeenCalled());
  const routes = JSON.parse(lastSaved().notify_routes);
  expect(routes.slack).not.toContain('run_complete');
  expect(routes.slack).toContain('ads_approvals');
  expect(routes.whatsapp.sort()).toEqual(['ads_approvals', 'review_approvals']);

  fireEvent.click(screen.getByLabelText('Successful runs to Slack'));
  fireEvent.click(screen.getByRole('button', { name: /Save notifications/ }));
  await waitFor(() => expect(JSON.parse(lastSaved().notify_routes).slack).toBeUndefined());
});

it('adds an email list that gets approvals only', async () => {
  render(<NotificationsTab />);
  fireEvent.click(await screen.findByRole('button', { name: /Add a list/ }));
  fireEvent.change(screen.getByLabelText('List name'), { target: { value: 'Paid search' } });
  fireEvent.change(screen.getByLabelText('List addresses'), { target: { value: 'ana@agency.test' } });
  fireEvent.click(screen.getByRole('button', { name: /Save notifications/ }));
  await waitFor(() => expect(api.saveNotifyConfig).toHaveBeenCalled());
  expect(JSON.parse(lastSaved().notify_email_lists)).toEqual([
    expect.objectContaining({ name: 'Paid search', to: 'ana@agency.test', events: ['review_approvals', 'ads_approvals'] }),
  ]);
});
