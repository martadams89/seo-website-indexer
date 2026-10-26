import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ReviewsApprovals } from './ReviewsApprovals';
import { reviewsApi, type ProfileChange } from './api';

const toast = vi.fn();
vi.mock('../AppContext', () => ({ useToast: () => toast }));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  reviewsApi: { replies: vi.fn(async () => []), changes: vi.fn(), approveChange: vi.fn(), rejectChange: vi.fn() },
}));

const change = (id: string, mediaFormat: 'PHOTO' | 'VIDEO'): ProfileChange => ({
  id, location_id: 'l1', kind: 'photo', payload: { photo: { sourceUrl: `https://cdn.test/${id}.${mediaFormat === 'VIDEO' ? 'mp4' : 'jpg'}`, category: 'AT_WORK', mediaFormat } },
  summary: `at work ${mediaFormat.toLowerCase()} ${id}`, rationale: null, source: 'mcp', status: 'needs_approval', findings: [], decided_at: null, published_at: null,
  error: null, result: null, created_at: '2026-10-26 09:00:00', location_title: 'Acme',
});

beforeEach(() => {
  vi.mocked(reviewsApi.changes).mockResolvedValue([change('a', 'PHOTO'), change('b', 'PHOTO'), change('c', 'VIDEO')]);
  vi.mocked(reviewsApi.approveChange).mockImplementation(async id => ({ ...change(id, 'PHOTO'), status: 'published' }));
});

it('publishes a batch of photos and videos in one go, and shows videos as videos', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ReviewsApprovals canManage reload={async () => {}} />);
  expect(await screen.findByText('New video')).toBeTruthy();
  expect(screen.getByLabelText('Proposed video')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Approve all 3 photos and videos/ }));
  await waitFor(() => expect(reviewsApi.approveChange).toHaveBeenCalledTimes(3));
  expect(toast).toHaveBeenCalledWith('success', 'Published 3 to Google');
});
