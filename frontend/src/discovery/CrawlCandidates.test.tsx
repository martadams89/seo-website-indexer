import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CrawlCandidates, type CrawlCandidate } from './CrawlCandidates';
import { discovery } from './api';
import { exportCsv } from './export';
vi.mock('./api', () => ({ discovery: { get: vi.fn(), post: vi.fn() } }));
vi.mock('./export', () => ({ exportCsv: vi.fn() }));
const row: CrawlCandidate = {
  id: 'candidate',
  source_url: 'https://publisher.example/long-story',
  target_url: 'https://example.com/',
  anchor: 'Example',
  crawl_date: null,
  provenance: 'Public extract',
  imported_at: '2020-01-01',
  state: 'pending',
  notes: '',
};
const setBusy = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(discovery.get).mockResolvedValue([{ ...row }]);
  vi.mocked(discovery.post).mockResolvedValue({ ok: true });
});
it('previews without refreshing persisted candidates', async () => {
  render(<CrawlCandidates siteId="site" canEdit setBusy={setBusy} />);
  await screen.findByText(row.source_url);
  fireEvent.change(screen.getByLabelText('Extract source and crawl release'), {
    target: { value: 'Selected extract' },
  });
  fireEvent.change(screen.getByLabelText('Crawl records'), { target: { value: '{}' } });
  vi.mocked(discovery.post).mockResolvedValue({
    added: 1,
    duplicates: 0,
    skipped: 0,
    records: 1,
    preview: true,
    rejected: [],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }));
  await screen.findByText(/Preview only: 1 new/);
  expect(discovery.post).toHaveBeenCalledWith('candidates/import', {
    site_id: 'site',
    text: '{}',
    provenance: 'Selected extract',
    preview: true,
  });
  expect(discovery.get).toHaveBeenCalledTimes(1);
  expect(setBusy).toHaveBeenLastCalledWith(false);
});
it('updates exported notes immediately after save', async () => {
  render(<CrawlCandidates siteId="site" canEdit setBusy={setBusy} />);
  await screen.findByText(row.source_url);
  fireEvent.click(screen.getByText('Review notes'));
  fireEvent.change(screen.getByLabelText('Notes for publisher.example'), {
    target: { value: 'New review evidence' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  await screen.findByText('Notes saved');
  fireEvent.click(screen.getByRole('button', { name: 'Export filtered candidates' }));
  expect(exportCsv).toHaveBeenCalledWith(
    expect.arrayContaining([expect.arrayContaining(['New review evidence'])]),
    'crawl-candidates.csv',
  );
});
it('clears bulk selection when filtering and moves promoted candidates out of the inbox', async () => {
  render(<CrawlCandidates siteId="site" canEdit setBusy={setBusy} />);
  await screen.findByText(row.source_url);
  fireEvent.click(screen.getByLabelText(`Select ${row.source_url}`));
  expect(
    (screen.getByRole('button', { name: 'Monitor selected (1/50)' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.change(screen.getByLabelText('Find candidates'), { target: { value: 'publisher' } });
  expect(
    (screen.getByRole('button', { name: 'Monitor selected (0/50)' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  vi.mocked(discovery.get).mockResolvedValue([{ ...row, state: 'promoted' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Add to backlink monitor' }));
  await waitFor(() => expect(screen.queryByText(row.source_url)).toBeNull());
  fireEvent.change(screen.getByLabelText('Review state'), { target: { value: 'promoted' } });
  await screen.findByText(row.source_url);
  expect((screen.getByLabelText(`Select ${row.source_url}`) as HTMLInputElement).disabled).toBe(true);
});
it('keeps viewer mutations disabled while retaining read and export access', async () => {
  render(<CrawlCandidates siteId="site" canEdit={false} setBusy={setBusy} />);
  await screen.findByText(row.source_url);
  for (const name of [
    'Import candidates',
    'Add to backlink monitor',
    'Dismiss candidate',
    'Create investigation task',
  ])
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Export filtered candidates' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it('bounds rendered candidates while exporting all filtered results', async () => {
  vi.mocked(discovery.get).mockResolvedValue(
    Array.from({ length: 51 }, (_, i) => ({
      ...row,
      id: `row-${i}`,
      source_url: `https://publisher.example/story-${i}`,
    })),
  );
  render(<CrawlCandidates siteId="site" canEdit setBusy={setBusy} />);
  await screen.findByText('https://publisher.example/story-0');
  expect(screen.queryByText('https://publisher.example/story-50')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Export filtered candidates' }));
  expect(vi.mocked(exportCsv).mock.calls[0][0]).toHaveLength(52);
  fireEvent.click(screen.getByRole('button', { name: 'Next candidates' }));
  await screen.findByText('https://publisher.example/story-50');
  expect(screen.queryByText('https://publisher.example/story-0')).toBeNull();
});
