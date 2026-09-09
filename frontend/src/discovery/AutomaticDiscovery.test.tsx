import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { StoreSearch } from './StoreSearch';
import { LinkDiscovery } from './LinkDiscovery';
import { SearchOpportunities } from './WebsiteAudit';
import { WorkBulkActions } from '../components/WorkBulkActions';
import { discovery } from './api';
import { api } from '../api';
vi.mock('./api', async (original) => {
  const value = await original<typeof import('./api')>();
  return { ...value, discovery: { get: vi.fn(), post: vi.fn() } };
});
vi.mock('../api', async (original) => {
  const value = await original<typeof import('../api')>();
  return { ...value, api: { ...value.api, bulkWorkItems: vi.fn() } };
});
beforeEach(() => vi.clearAllMocks());
it('searches and previews store metadata before applying it as a draft', async () => {
  const use = vi.fn();
  const app = {
    id: '123',
    name: 'Store Fixture',
    publisher: 'Publisher',
    url: 'https://apps.apple.com/app/id123',
    platform: 'apple',
  };
  const draft = { platform: 'apple', name: 'Store Fixture', description: 'Full listing', keywords: '' };
  vi.mocked(discovery.post).mockImplementation(async (path) =>
    path === 'stores/search' ? [app] : { app, draft, unavailable: ['keywords'], note: 'Public metadata' },
  );
  render(<StoreSearch canEdit onUse={use} onBusy={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Search app or publisher'), { target: { value: 'Store Fixture' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search store' }));
  await screen.findByText('Store Fixture');
  expect(use).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Preview listing' }));
  await screen.findByText('Full listing');
  fireEvent.click(screen.getByRole('button', { name: 'Use listing as new draft' }));
  expect(use).toHaveBeenCalledWith(draft);
});
it('discovers link candidates directly and reloads the inbox', async () => {
  const complete = vi.fn(async () => {});
  vi.mocked(discovery.post).mockResolvedValue({
    searched: 2,
    checked: 2,
    observed: 1,
    reported: 0,
    added: 1,
    duplicates: 0,
    monitored: 0,
    sources: ['Public search'],
    warnings: [],
    pages: [],
  });
  render(<LinkDiscovery siteId="site" canEdit monitor={false} onComplete={complete} onBusy={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Discover link candidates' }));
  await screen.findByText(/1 new candidates/);
  expect(complete).toHaveBeenCalledOnce();
  expect(discovery.post).toHaveBeenCalledWith('links/discover', {
    site_id: 'site',
    query: '',
    monitor: false,
  });
});
it('shows fetched low-volume queries and diagnoses connection errors', async () => {
  vi.mocked(discovery.get).mockResolvedValue({
    from: '2026-01-01',
    to: '2026-01-29',
    opportunities: [],
    queries: [
      {
        site_id: 'site',
        query: 'Low volume',
        kind: 'Query to review',
        confidence: 'Observed',
        clicks: 0,
        impressions: 2,
        ctr: 0,
        position: 25,
        reason: 'Review relevance',
      },
    ],
    sync: {
      connected: true,
      property: 'sc-domain:example.com',
      last_success: null,
      error: 'Reconnect Google account',
      truncated: false,
    },
    methodology: 'Fixture',
  });
  render(
    <MemoryRouter>
      <SearchOpportunities siteId="site" canEdit />
    </MemoryRouter>,
  );
  await screen.findByText('Low volume');
  expect(screen.getByRole('alert').textContent).toContain('Reconnect Google');
  fireEvent.change(screen.getByLabelText('Query view'), { target: { value: 'priority' } });
  await screen.findByText('No queries meet the priority rules');
});
it('previews and applies bulk work status only after confirmation', async () => {
  const complete = vi.fn(async () => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(api.bulkWorkItems).mockResolvedValue({ affected: 2 });
  render(
    <WorkBulkActions
      ids={['a', 'b']}
      members={[]}
      disabled={false}
      onComplete={complete}
      onError={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(api.bulkWorkItems).toHaveBeenNthCalledWith(1, ['a', 'b'], { status: 'in_progress' }, true);
  expect(api.bulkWorkItems).toHaveBeenNthCalledWith(2, ['a', 'b'], { status: 'in_progress' });
});
it('leaves work unchanged when bulk confirmation is cancelled', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.mocked(api.bulkWorkItems).mockResolvedValue({ affected: 1 });
  render(
    <WorkBulkActions ids={['a']} members={[]} disabled={false} onComplete={vi.fn()} onError={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(api.bulkWorkItems).toHaveBeenCalledOnce();
});
