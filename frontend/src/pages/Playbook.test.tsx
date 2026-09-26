import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import PlaybookPage from './Playbook';
import { api, type PlaybookOpportunity, type PlaybookView } from '../api';

const toast = vi.fn();
const setSiteScope = vi.fn();
let siteScope = 's1';

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: {
    getPlaybook: vi.fn(),
    refreshPlaybook: vi.fn(),
    setPlaybookStatus: vi.fn(),
    draftPlaybookFix: vi.fn(),
    sendPlaybookToWork: vi.fn(),
    getPlaybookSummary: vi.fn(async () => ({ sites: [] })),
  },
}));
vi.mock('../AppContext', () => ({ useApp: () => ({ toast, sites: [] }), useToast: () => toast }));
vi.mock('../insights/InsightsContext', () => ({ useInsights: () => ({ siteScope, setSiteScope, range: 30, setRange: vi.fn() }) }));
vi.mock('../workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ active: { id: 'w1', name: 'Workspace', permissions: { manage_sites: true } } }) }));

const opportunity: PlaybookOpportunity = {
  id: 'o1', site_id: 's1', kind: 'ctr_gap', subtype: null, page: 'https://a.com/boots', secondary_page: null,
  headline: 'Rewrite the title and description of /boots', steps: [
    { text: 'Replace the title with a query-led one.', copy: 'Waterproof hiking boots — free UK delivery' },
    { text: 'Rewrite the meta description.' },
  ],
  evidence: { currentTitle: 'Boots', queries: [{ query: 'waterproof hiking boots', impressions: 4000, clicks: 40, position: 3.2, expectedCtr: 0.09 }] },
  low: 40, high: 110, point: 70, effort: 'S', confidence: 'high', counted: 1, hidden: 0, status: 'open', changed: 0,
  first_seen: '2026-09-20T00:00:00Z', last_seen: '2026-09-25T00:00:00Z', computed_at: '2026-09-25T02:00:00Z',
  work_item_id: null, draft: null, draft_at: null, done_at: null,
};

const view: PlaybookView = {
  site: { id: 's1', name: 'Alpha Outdoors', domain: 'a.com', googleConnected: true },
  computedAt: '2026-09-25T02:00:00Z',
  summary: {
    counted: 3, low: 90, high: 260, capped: false, siteMonthlyClicks: 1200, blockers: 1, smallSite: false, curveLabels: ['generic'], brandTerms: ['alpha'],
    quickWins: { count: 2, low: 60, high: 150 }, kinds: { ctr_gap: 2, striking_distance: 1 }, computedAt: '2026-09-25T02:00:00Z',
  },
  blockers: [{ kind: 'index_blocker', page: 'https://a.com/tents', headline: '/tents is not indexed', detail: 'Blocked by robots.txt', atStake: 300 }],
  opportunities: [
    opportunity,
    { ...opportunity, id: 'o2', kind: 'striking_distance', page: 'https://a.com/socks', headline: 'Push /socks up from position 7', low: 30, high: 90, effort: 'M', confidence: 'medium', steps: [] },
    { ...opportunity, id: 'o3', page: 'https://a.com/hats', headline: 'Tiny one', low: 1, high: 4 },
  ],
  results: [{ id: 'r1', kind: 'content_decay', page: 'https://a.com/repair', headline: 'Refresh /repair', doneAt: '2026-08-01T00:00:00Z', low: 20, high: 60, status: 'measured', readyOn: '2026-09-01', realised: 35, withinRange: true }],
  data: { searchConsoleDays: 90, queryRows: 5400, querySync: { checked_at: '2026-09-25T01:00:00Z', success_at: '2026-09-25T01:00:00Z', error: null, truncated: 0, period_start: '2026-06-27', period_end: '2026-09-24', row_count: 5400 }, inventoryCoverage: 0.95, inspected: 40, sitemapPages: 50, cruxConfigured: false },
  methodology: 'Estimates use a site-specific CTR curve and are ranges, not promises.',
};

function renderPage(url = '/insights/playbook') {
  return render(<MemoryRouter initialEntries={[url]}><PlaybookPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  siteScope = 's1';
  vi.mocked(api.getPlaybook).mockResolvedValue(view);
});

it('renders the tiles and blockers from the playbook view', async () => {
  renderPage();
  await screen.findByText('Alpha Outdoors', { exact: false });
  expect(screen.getByText('Opportunities')).toBeTruthy();
  expect(screen.getByText('+90–260')).toBeTruthy();
  expect(screen.getByText('2 snippet · 1 striking distance')).toBeTruthy();
  expect(screen.getByText('+60–150 clicks/month · about an hour each')).toBeTruthy();
  expect(screen.getByText('Data readiness')).toBeTruthy();
  expect(screen.getByText('Fix first')).toBeTruthy();
  expect(screen.getByText('~300 clicks/month at stake')).toBeTruthy();
  expect(api.getPlaybook).toHaveBeenCalledWith('s1');
});

it('renders a row with its estimate and hides small items by default', async () => {
  renderPage();
  await screen.findByText('Rewrite the title and description of /boots');
  expect(screen.getByText('+40–110')).toBeTruthy();
  expect(screen.getByText('/boots')).toBeTruthy();
  expect(screen.getByText('~1 h')).toBeTruthy();
  expect(screen.queryByText('Tiny one')).toBeNull();
  fireEvent.click(screen.getByLabelText('Show hidden and small items'));
  expect(screen.getByText('Tiny one')).toBeTruthy();
  expect(screen.getByText('Inside range')).toBeTruthy();
});

it('opens details with steps and a copy button, and dismisses the item', async () => {
  vi.mocked(api.setPlaybookStatus).mockResolvedValue({ opportunity: { ...opportunity, status: 'dismissed' } });
  renderPage();
  await screen.findByText('Rewrite the title and description of /boots');
  fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('Replace the title with a query-led one.');
  expect(dialog.textContent).toContain('Estimated +40–110 clicks a month · ~1 h · high confidence');
  expect(screen.getByRole('button', { name: /^Copy:/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Draft with AI' })).toBeTruthy();
  expect(screen.getByText('waterproof hiking boots')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(api.setPlaybookStatus).toHaveBeenCalledWith('s1', 'o1', 'dismissed'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('renders the day-one empty state when nothing has been computed', async () => {
  vi.mocked(api.getPlaybook).mockResolvedValue({ ...view, computedAt: null, summary: null, blockers: [], opportunities: [], results: [] });
  renderPage();
  await screen.findByText('Your first playbook arrives after the nightly run.');
  expect(screen.getByText('Google account connected')).toBeTruthy();
  expect(screen.queryByText('Estimated upside')).toBeNull();
});

it('shows per-site cards when the scope is all sites', async () => {
  siteScope = 'all';
  vi.mocked(api.getPlaybookSummary).mockResolvedValue({ sites: [{ id: 's1', name: 'Alpha Outdoors', domain: 'a.com', computedAt: view.computedAt, summary: view.summary, top: [{ id: 'o1', kind: 'ctr_gap', page: 'https://a.com/boots', headline: 'Rewrite /boots', low: 40, high: 110, effort: 'S', confidence: 'high' }] }] });
  renderPage();
  await screen.findByText('Rewrite /boots');
  fireEvent.click(screen.getByRole('button', { name: 'Open playbook' }));
  expect(setSiteScope).toHaveBeenCalledWith('s1');
});
