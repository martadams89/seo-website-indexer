import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import ApprovePage from './Approve';
import { reviewsApi } from '../reviews/api';
import { adsApi } from '../ads/api';

const toast = vi.fn();
vi.mock('../AppContext', () => ({ useToast: () => toast }));
vi.mock('../workspace/WorkspaceContext', () => ({
  useWorkspace: () => ({ active: { id: 'ws1', name: 'Acme', slug: 'acme', permissions: { manage_reviews: true, manage_ads: false } } }),
}));
vi.mock('../reviews/api', async (original) => ({
  ...(await original<typeof import('../reviews/api')>()),
  reviewsApi: { replyPlan: vi.fn(), approve: vi.fn(), reject: vi.fn(), change: vi.fn() },
}));
vi.mock('../ads/api', async (original) => ({
  ...(await original<typeof import('../ads/api')>()),
  adsApi: { change: vi.fn(), approve: vi.fn(), reject: vi.fn(), revert: vi.fn() },
}));

const plan = {
  id: 'r1', location_id: 'l1', review_id: 'v1', action: 'reply', text: 'Sorry we were late.', previous_reply: null, rationale: 'Low rating', rating: 2,
  source: 'mcp', status: 'needs_approval', findings: [{ severity: 'approval', code: 'low_rating', message: 'Replies to 2-star reviews need approval.' }],
  decided_at: null, published_at: null, error: null, created_at: '2026-10-26 09:00:00', location_title: 'Acme Roofing',
  review: { id: 'v1', location_id: 'l1', reviewer_name: 'Sam', reviewer_photo: null, anonymous: false, rating: 2, comment: 'They were late.', create_time: null, reply_comment: null, reply_update_time: null, reply_state: null, reply_policy_violation: null, reply_url: null, media: [], pending_reply: null },
};

const open = (path: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/approve/:kind/:id" element={<ApprovePage />} /></Routes></MemoryRouter>);

beforeEach(() => {
  vi.mocked(reviewsApi.replyPlan).mockReset();
  vi.mocked(reviewsApi.approve).mockReset();
});

it('opens a proposed reply from a notification link and publishes the edited text', async () => {
  vi.mocked(reviewsApi.replyPlan).mockResolvedValueOnce(plan as never).mockResolvedValueOnce({ ...plan, status: 'published', text: 'Sorry we were late — we\'ll call ahead next time.' } as never);
  vi.mocked(reviewsApi.approve).mockResolvedValue({ ...plan, status: 'published' } as never);
  open('/approve/reply/r1');
  const box = await screen.findByLabelText('Reply to approve');
  expect(screen.getByText('They were late.')).toBeTruthy();
  fireEvent.change(box, { target: { value: 'Sorry we were late — we\'ll call ahead next time.' } });
  fireEvent.click(screen.getByRole('button', { name: /Publish edited reply/ }));
  await waitFor(() => expect(reviewsApi.approve).toHaveBeenCalledWith('r1', 'Sorry we were late — we\'ll call ahead next time.'));
  expect(await screen.findByText(/already been decided/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
});

it('explains a link to an item in another workspace', async () => {
  vi.mocked(reviewsApi.replyPlan).mockRejectedValue(new Error('Reply not found.'));
  open('/approve/reply/elsewhere');
  expect(await screen.findByText(/may belong to another workspace/)).toBeTruthy();
});

it('shows a Google Ads change read-only without the Ads permission', async () => {
  vi.mocked(adsApi.change).mockResolvedValue({
    id: 'c1', ads_account_id: 'a1', source: 'mcp', kind: 'budget', summary: 'Raise the daily budget to £40', rationale: null, operations: [], impact: {},
    findings: [], status: 'needs_approval', decided_at: null, applied_at: null, error: null, reverts_change_id: null, created_at: '2026-10-26T09:00:00Z',
    account: { id: 'a1', name: 'Acme Ads', customer_id: '123-456-7890', currency: 'GBP' },
  } as never);
  open('/approve/ads/c1');
  expect(await screen.findByText('Raise the daily budget to £40')).toBeTruthy();
  expect(screen.getByText(/needs the “Manage Google Ads” permission/)).toBeTruthy();
  expect((screen.getByRole('button', { name: /Approve & apply/ }) as HTMLButtonElement).disabled).toBe(true);
});
