import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CrawlComparison } from './CrawlComparison';
import { discovery } from './api';
import { exportCsv } from './export';
vi.mock('./api', () => ({ discovery: { get: vi.fn() } }));
vi.mock('./export', () => ({ exportCsv: vi.fn() }));
const imports = [
  { id: 'new', provenance: 'New release', imported_at: '2021-01-01', comparable: 1 },
  { id: 'old', provenance: 'Old release', imported_at: '2020-01-01', comparable: 1 },
];
const result = {
  before: { ...imports[1], observations: 1, rejected_records: 0 },
  after: { ...imports[0], observations: 0, rejected_records: 1 },
  counts: { newly_observed: 0, not_observed: 1, observed_both: 0, evidence_changed: 0 },
  methodology: 'Archive absence is not confirmed live link loss.',
  rows: [
    {
      source_url: 'https://publisher.example/',
      target_url: 'https://example.com/',
      status: 'not_observed',
      evidence_changed: false,
      before: [{ anchor: 'Previous', crawl_date: null }],
      after: [],
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(discovery.get).mockImplementation(async (path) =>
    path.startsWith('candidates/imports') ? imports : result,
  );
});
it('compares selected extracts and exports evidence without write access', async () => {
  render(<CrawlComparison siteId="site" />);
  fireEvent.click(screen.getByText('Compare crawl extracts'));
  fireEvent.click(screen.getByRole('button', { name: 'Load comparison imports' }));
  await screen.findByLabelText('Baseline extract');
  fireEvent.click(screen.getByRole('button', { name: 'Compare extracts' }));
  await screen.findByText(result.methodology);
  expect(discovery.get).toHaveBeenCalledWith('candidates/compare?site_id=site&before_id=old&after_id=new');
  fireEvent.click(screen.getByRole('button', { name: 'Export comparison' }));
  expect(exportCsv).toHaveBeenCalledWith(
    expect.arrayContaining([expect.arrayContaining([JSON.stringify(result.rows[0].before)])]),
    'crawl-comparison.csv',
  );
  fireEvent.change(screen.getByLabelText('Comparison results'), { target: { value: 'newly_observed' } });
  expect(screen.queryByText('https://publisher.example/')).toBeNull();
  fireEvent.change(screen.getByLabelText('Baseline extract'), { target: { value: 'new' } });
  expect(screen.queryByText(result.methodology)).toBeNull();
  expect((screen.getByRole('button', { name: 'Compare extracts' }) as HTMLButtonElement).disabled).toBe(true);
});
it('explains unavailable legacy snapshots and permits refreshing imports', async () => {
  vi.mocked(discovery.get).mockResolvedValue([{ ...imports[0], comparable: 0 }]);
  render(<CrawlComparison siteId="site" />);
  fireEvent.click(screen.getByText('Compare crawl extracts'));
  fireEvent.click(screen.getByRole('button', { name: 'Load comparison imports' }));
  await screen.findByText(/Earlier receipts without snapshots/);
  expect((screen.getByRole('button', { name: 'Compare extracts' }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(discovery.get).mockResolvedValue(imports);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh comparison imports' }));
  await screen.findAllByRole('option', { name: /Old release/ });
});
it('shows load failures without a misleading empty comparison', async () => {
  vi.mocked(discovery.get).mockRejectedValue(new Error('Connection unavailable'));
  render(<CrawlComparison siteId="site" />);
  fireEvent.click(screen.getByText('Compare crawl extracts'));
  fireEvent.click(screen.getByRole('button', { name: 'Load comparison imports' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('No matching observations in these extracts.')).toBeNull();
});
