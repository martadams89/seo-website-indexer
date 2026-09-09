import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AppStoreStudio } from './AppStoreStudio';
import { ContentStudio } from './ContentStudio';
import { Experiments } from './Experiments';
import { discovery } from './api';
import { apiFetch } from '../api/client';
import { requestDraftNavigation } from './useUnsavedChanges';
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  discovery: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  apiFetch: vi.fn(),
}));
const cases = [
  { Component: AppStoreStudio, label: 'Delete draft', field: 'App name', path: 'listings' },
  { Component: ContentStudio, label: 'Delete brief', field: 'Brief title', path: 'documents' },
  { Component: Experiments, label: 'Delete measurement plan', field: 'Change title', path: 'documents' },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.mocked(apiFetch).mockResolvedValue({ ok: true });
  vi.mocked(discovery.get).mockImplementation(async (path) =>
    path === 'listings'
      ? [
          {
            id: 'saved',
            updated_at: '2026-01-01',
            draft: {
              platform: 'apple',
              locale: 'en-GB',
              name: 'Saved fixture',
              subtitle: '',
              description: '',
              keywords: '',
              promotional_text: '',
              target_terms: [],
            },
            analysis: { fields: [], findings: [], terms: [], methodology: '', source: '' },
          },
        ]
      : [
          {
            id: 'saved',
            updated_at: '2026-01-01',
            body: { title: 'Saved fixture', start_date: '2026-01-01', metric: 'clicks', window_days: '28' },
          },
        ],
  );
});
it.each(cases)(
  'deletes and clears the saved draft through $label',
  async ({ Component, label, field, path }) => {
    render(<Component siteId="site" canEdit setBusy={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Saved fixture/ }));
    fireEvent.change(screen.getByLabelText(field), { target: { value: 'Unsaved edit' } });
    fireEvent.click(screen.getByRole('button', { name: label }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Saved fixture')).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(apiFetch).toHaveBeenCalledWith(`/api/platform/discovery/${path}/saved`, { method: 'DELETE' });
    expect(screen.queryByRole('button', { name: /Saved fixture/ })).toBeNull();
    expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(requestDraftNavigation()).toBe(true));
  },
);
it('keeps the draft when cancelled or when deletion fails, and allows retry', async () => {
  render(<AppStoreStudio siteId="site" canEdit setBusy={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Saved fixture/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(apiFetch).not.toHaveBeenCalled();
  expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Saved fixture');
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Temporary failure'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Saved fixture');
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
});
it.each(cases)('disables $label for viewers', async ({ Component, label }) => {
  render(<Component siteId="site" canEdit={false} setBusy={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Saved fixture/ }));
  expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true);
});
