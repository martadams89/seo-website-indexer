import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStoreStudio } from './AppStoreStudio';
import { WebsiteAudit } from './WebsiteAudit';
import { ContentStudio } from './ContentStudio';
import { discovery } from './api';
import { requestDraftNavigation } from './useUnsavedChanges';

vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  original.discovery.get = vi.fn();
  original.discovery.post = vi.fn();
  return original;
});
const setBusy = vi.fn();
beforeEach(() => {
  vi.mocked(discovery.get).mockReset();
  vi.mocked(discovery.post).mockReset();
  setBusy.mockClear();
});

describe('draft editing', () => {
  it('protects a changed ASO draft on tool navigation and clears the guard after save', async () => {
    vi.mocked(discovery.get).mockResolvedValue([]);
    vi.mocked(discovery.post).mockImplementation(async (_path, body) => ({
      id: 'listing',
      draft: (body as { draft: unknown }).draft,
      analysis: { fields: [], findings: [], terms: [], methodology: 'test', source: '' },
    }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AppStoreStudio siteId="site" canEdit setBusy={setBusy} />);
    fireEvent.change(screen.getByLabelText('App name'), { target: { value: 'Field evidence' } });
    expect(requestDraftNavigation()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
    expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Field evidence');
    fireEvent.click(screen.getByRole('button', { name: 'Save & audit draft' }));
    await screen.findByText(/Draft and audit saved/);
    await waitFor(() => expect(requestDraftNavigation()).toBe(true));
    expect(discovery.post).toHaveBeenCalledWith(
      'listings',
      expect.objectContaining({
        site_id: 'site',
        draft: expect.objectContaining({ name: 'Field evidence' }),
      }),
    );
  });
  it('protects programmatically added brief outlines and keeps read-only saves disabled', async () => {
    vi.mocked(discovery.get).mockResolvedValue([]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = render(<ContentStudio siteId="site" canEdit setBusy={setBusy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add evidence-led outline' }));
    expect(requestDraftNavigation()).toBe(false);
    view.unmount();
    render(<AppStoreStudio siteId="site" canEdit={false} setBusy={setBusy} />);
    expect((screen.getByRole('button', { name: 'Save & audit draft' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('audit recovery', () => {
  it('retries an unavailable history without presenting it as an empty successful audit', async () => {
    let historyAttempts = 0;
    vi.mocked(discovery.get).mockImplementation(async (path) => {
      if (path.startsWith('jobs/current')) return null;
      if (++historyAttempts === 1) throw new Error('Temporarily unavailable');
      return { history: [], report: null, comparison: null };
    });
    render(
      <MemoryRouter>
        <WebsiteAudit siteId="site" canEdit setBusy={setBusy} />
      </MemoryRouter>,
    );
    await screen.findByText('Audit history unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading history' }));
    await screen.findByText('Build your first evidence snapshot');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('resumes an existing job and shows the resulting report', async () => {
    const job = { id: 'active', state: 'running', completed: 0, total: 1, site_id: 'site', error: null };
    const empty = { history: [], report: null, comparison: null };
    vi.mocked(discovery.get).mockImplementation(async (path) => {
      if (path.startsWith('jobs/current')) return job;
      if (path === 'jobs/active') return { ...job, state: 'succeeded', completed: 1 };
      return empty;
    });
    render(
      <MemoryRouter>
        <WebsiteAudit siteId="site" canEdit setBusy={setBusy} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(discovery.get).toHaveBeenCalledWith('jobs/active', expect.any(AbortSignal)));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Run audit' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(setBusy).toHaveBeenCalledWith(true);
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });
});
