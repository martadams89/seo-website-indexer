import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BusinessProfileTab } from './BusinessProfileTab';
import { ReviewsSetupView } from './ReviewsSetup';
import { reviewsApi, type ProfileOverview, type ReviewLocation, type ReviewsSetup } from './api';
import { openGoogleConsent } from '../ads/googleConnect';

const toast = vi.fn();
vi.mock('../AppContext', () => ({ useToast: () => toast }));
vi.mock('../components/McpConnect', () => ({ McpConnect: () => null }));
vi.mock('../workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ active: { id: 'ws1', permissions: { manage_integrations: true } } }) }));
vi.mock('../ads/googleConnect', () => ({
  openGoogleConsent: vi.fn(async () => {}), openApiEnable: vi.fn(async () => []), useApisEnabled: () => {}, useGoogleAuthSuccess: () => {},
}));
vi.mock('../api/client', () => ({
  apiFetch: vi.fn(async (url: string) => (url === '/api/auth/google/projects'
    ? { builtin_available: false, projects: [{ project: '111111111111', source_id: 'me@acme.test', builtin: false, connections: [{ id: 'me@acme.test', email: 'me@acme.test', limited_to: null, in_workspace: true, sites: 3, ads_clients: 0, locations: 0 }] }] }
    : {})),
}));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  reviewsApi: { profile: vi.fn(), editProfile: vi.fn(), resolveGoogleUpdates: vi.fn(), checkGoogleUpdates: vi.fn(), connectInvites: vi.fn(async () => []) },
}));

const links = { access_form: 'https://support.google.com/business/contact/api_default', quotas: 'https://console.cloud.google.com/q', enable_apis: 'https://console.cloud.google.com/e', business_profile: 'https://business.google.com/locations' };

const setup: ReviewsSetup = {
  builtin_oauth_client: true, project: '111111111111', links, linked_locations: 0, ready: false,
  steps: { google_connected: true, business_scope: true, api_enabled: true, access_approved: false, locations_linked: false },
  connections: [{
    id: 'me@acme.test', email: 'me@acme.test', project: '111111111111', has_business_scope: true, has_cloud_scope: false, needs_reauth: false,
    business_only: false, locations: 0, api: 'not_approved', accounts: null, message: null, hint: null, links,
  }],
};

const location = { id: 'loc1', title: 'Acme Roofing', location_name: 'locations/1' } as ReviewLocation;

const overview: ProfileOverview = {
  profile: {
    title: 'Acme Roofing', description: 'Roofers.', primary_phone: '+44 113 496 0000', additional_phones: [], website: 'https://roof.example/',
    primary_category: 'Roofing contractor', additional_categories: [], address: '1 High St, Leeds', service_area: [], open_status: 'OPEN',
    regular_hours: [{ day: 'MONDAY', open: '08:00', close: '17:00' }], special_hours: [], verified: true, has_google_updated: true, has_pending_edits: false,
    maps_uri: null, new_review_uri: null,
  },
  checklist: { score: 64, items: [{ id: 'description', label: 'Business description', status: 'warn', detail: 'Only 8 characters.' }] },
  rules: { profile: 'approval', posts: 'approval', photos: 'approval', alert_google_updates: true },
  google_updates: { fields: ['website'], pending: [], google: { website: 'https://spam.example/' }, mask: 'websiteUri' },
  google_updates_checked_at: null, photos: { total: 0 }, photos_error: null, posts: { total: 0, newest: null }, posts_error: null, pending_changes: [],
};

beforeEach(() => {
  vi.mocked(reviewsApi.profile).mockResolvedValue(overview);
  vi.mocked(reviewsApi.editProfile).mockResolvedValue({ id: 'c1', status: 'published', findings: [] } as never);
  vi.mocked(reviewsApi.resolveGoogleUpdates).mockResolvedValue({ id: 'c2', status: 'published', findings: [] } as never);
  vi.mocked(openGoogleConsent).mockClear();
});

it('reuses the project the workspace already has, with nothing to re-enter', async () => {
  render(<ReviewsSetupView setup={setup} canManage reload={async () => {}} onLinked={() => {}} />);
  const picker = await screen.findByLabelText(/Google Cloud project/) as HTMLSelectElement;
  await waitFor(() => expect(picker.value).toBe('existing:me@acme.test'));
  expect(screen.queryByLabelText('OAuth client ID')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/ }));
  await waitFor(() => expect(openGoogleConsent).toHaveBeenCalledWith(expect.objectContaining({ projectFrom: 'me@acme.test', business: true })));
  expect(vi.mocked(openGoogleConsent).mock.calls[0][0]).not.toHaveProperty('clientId');
});

it('connects through a different Cloud project, asking only for Business Profile', async () => {
  render(<ReviewsSetupView setup={setup} canManage reload={async () => {}} onLinked={() => {}} />);
  expect(screen.getByText('Apply for Business Profile API access')).toBeTruthy();
  const picker = await screen.findByLabelText(/Google Cloud project/);
  await waitFor(() => expect((picker as HTMLSelectElement).value).toBe('existing:me@acme.test'));
  fireEvent.change(picker, { target: { value: 'custom' } });
  expect((screen.getByLabelText(/Only ask Google for Business Profile access/) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('OAuth client ID'), { target: { value: '222222222222-gbp.apps.googleusercontent.com' } });
  fireEvent.change(screen.getByLabelText('OAuth client secret'), { target: { value: 'GOCSPX-secret' } });
  fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/ }));
  await waitFor(() => expect(openGoogleConsent).toHaveBeenCalledWith(expect.objectContaining({
    business: true, only: ['business'], clientId: '222222222222-gbp.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret',
  })));
});

it('sends only the fields that changed, and settles Google-suggested edits', async () => {
  render(<BusinessProfileTab locations={[location]} locationId="loc1" canManage onPick={() => {}} reload={async () => {}} />);
  expect(await screen.findByText('64%')).toBeTruthy();
  expect(screen.getByText('https://spam.example/')).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText(/What the business does/), { target: { value: 'Family-run roofers in Leeds.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Monday period' }));
  fireEvent.click(screen.getByRole('button', { name: /Save to Google/ }));
  await waitFor(() => expect(reviewsApi.editProfile).toHaveBeenCalled());
  const [, edit] = vi.mocked(reviewsApi.editProfile).mock.calls[0];
  expect(edit.description).toBe('Family-run roofers in Leeds.');
  expect(edit.primary_phone).toBeUndefined();
  expect(edit.regular_hours).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: /Keep my version/ }));
  await waitFor(() => expect(reviewsApi.resolveGoogleUpdates).toHaveBeenCalledWith('loc1', 'mine'));
});
