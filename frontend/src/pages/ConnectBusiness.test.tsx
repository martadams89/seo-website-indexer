import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import ConnectBusinessPage from './ConnectBusiness';
import { connectApi, type ConnectLinkInfo } from '../connect/api';

vi.mock('../connect/api', () => ({ connectApi: { info: vi.fn(), start: vi.fn(), locations: vi.fn(), share: vi.fn() } }));

const base: ConnectLinkInfo = {
  status: 'open', workspace: 'Bright Smiles Dental', from: 'Martin', client_name: 'Bright Smiles Dental', expires_at: '2026-11-02T00:00:00Z',
  can_start: true, can_pick: false, connected_email: null, shared: [],
};
const open = () => render(<MemoryRouter initialEntries={['/connect/tok123']}><Routes><Route path="/connect/:token" element={<ConnectBusinessPage />} /></Routes></MemoryRouter>);

beforeEach(() => { vi.mocked(connectApi.info).mockReset(); vi.mocked(connectApi.locations).mockReset(); vi.mocked(connectApi.share).mockReset(); });

it('explains what is asked and sends the client to Google', async () => {
  vi.mocked(connectApi.info).mockResolvedValue(base);
  vi.mocked(connectApi.start).mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  open();
  expect(await screen.findByText('Connect your Google Business Profile')).toBeTruthy();
  expect(screen.getByText(/Martin \(Bright Smiles Dental\) would like to help manage/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Connect with Google/ }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
  expect(connectApi.start).toHaveBeenCalledWith('tok123');
  vi.unstubAllGlobals();
});

it('lets the client pick which profiles to share after signing in', async () => {
  vi.mocked(connectApi.info).mockResolvedValue({ ...base, status: 'connected', can_pick: true, connected_email: 'owner@brightsmiles.test' });
  const leeds = { account_name: 'accounts/9', account_title: 'Bright Smiles', location_name: 'locations/1', title: 'Bright Smiles Leeds', address: '1 Park Row, Leeds', shared: false };
  const york = { ...leeds, location_name: 'locations/2', title: 'Bright Smiles York', address: '2 Stonegate, York' };
  vi.mocked(connectApi.locations).mockResolvedValueOnce({ email: 'owner@brightsmiles.test', error: null, hint: null, locations: [leeds, york], account_errors: [] })
    .mockResolvedValueOnce({ email: 'owner@brightsmiles.test', error: null, hint: null, locations: [leeds, { ...york, shared: true }], account_errors: [] });
  vi.mocked(connectApi.share).mockResolvedValue({ shared: ['Bright Smiles York'], errors: [] });
  open();
  fireEvent.click(await screen.findByText('Bright Smiles York'));
  fireEvent.click(screen.getByRole('button', { name: /Share 1 profile/ }));
  await waitFor(() => expect(connectApi.share).toHaveBeenCalledWith('tok123', [{ accountName: 'accounts/9', locationName: 'locations/2' }]));
  expect(await screen.findByText(/Shared Bright Smiles York/)).toBeTruthy();
});

it('tells someone in another browser that the link was used', async () => {
  vi.mocked(connectApi.info).mockResolvedValue({ ...base, status: 'connected', can_start: false });
  open();
  expect(await screen.findByText('This link has been used')).toBeTruthy();
  expect(connectApi.locations).not.toHaveBeenCalled();
});
