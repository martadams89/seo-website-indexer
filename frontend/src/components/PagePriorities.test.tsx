import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PagePriorities } from './PagePriorities';
import { api } from '../api';

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: {
    getInternalLinks: vi.fn(async () => ({
      sitemapPages: 10, inventoried: 10, coverage: 1, orphansConfirmed: true, weakOrOrphanUrls: ['https://a.com/guide'],
      targets: [{
        url: 'https://a.com/guide', title: 'Guide', inbound: 0, kind: 'orphan', pageTwo: true, clicks: 3, impressions: 800,
        position: 11.2, anchorHint: 'Hiking guide',
        suggestions: [{ source: 'https://a.com/boots', sourceTitle: 'Boots', sharedTerms: ['hiking'], sourceClicks: 40 }],
      }],
    })),
    getSnippetChanges: vi.fn(async () => [{
      id: 1, url: 'https://a.com/boots', changed_at: '2026-08-01T10:00:00Z', old_title: 'Boots', new_title: 'Waterproof boots',
      old_description: null, new_description: null,
      before: { clicks: 20, impressions: 1000, ctr: 0.02, position: 8, days: 28 },
      after: { clicks: 40, impressions: 1000, ctr: 0.04, position: 8, days: 28 },
      ctrChangePct: 100, positionChange: 0, verdict: 'improved', readyOn: '2026-08-18',
    }]),
    getPageVitals: vi.fn(async () => ({
      configured: true,
      pages: [{ url: 'https://a.com/boots', day: '2026-09-26', has_data: 1, lcp_ms: 4500, inp_ms: 150, cls: 0.02, rating: 'poor', clicks: 40, impressions: 1000, position: 8 }],
    })),
    refreshPageVitals: vi.fn(),
  },
}));

it('shows internal-link gaps, title change results and page vitals', async () => {
  render(<PagePriorities siteId="s1" onError={() => undefined} />);
  await waitFor(() => expect(screen.getByText('orphan')).toBeTruthy());
  expect(screen.getByText('page two')).toBeTruthy();
  expect(screen.getByText('Anchor idea: “Hiking guide”')).toBeTruthy();
  expect(screen.getByText('2.0% → 4.0%')).toBeTruthy();
  expect(screen.getByText('CTR up')).toBeTruthy();
  expect(screen.getByText('4.5 s')).toBeTruthy();
  expect(screen.getByText('Poor')).toBeTruthy();
  expect(api.getInternalLinks).toHaveBeenCalledWith('s1');
});
