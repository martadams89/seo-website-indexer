import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BusinessPostsTab } from './BusinessPostsTab';
import { reviewsApi, type ProfileChange, type ReviewLocation } from './api';

const toast = vi.fn();
vi.mock('../AppContext', () => ({ useToast: () => toast }));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  reviewsApi: { posts: vi.fn(), changes: vi.fn(), createPost: vi.fn(), rejectChange: vi.fn(), deletePost: vi.fn() },
}));

const location = { id: 'loc1', title: 'Acme Roofing', location_name: 'locations/1' } as ReviewLocation;
const scheduled: ProfileChange = {
  id: 'c1', location_id: 'loc1', kind: 'post', payload: { post: { topicType: 'STANDARD', summary: 'Gutter cleaning slots open next week.' } }, summary: 'Update: Gutter cleaning…',
  rationale: null, source: 'mcp', status: 'scheduled', publish_at: '2026-11-03T09:00:00.000Z', findings: [], decided_at: null, published_at: null, error: null, result: null, created_at: '2026-10-27 09:00:00',
};

beforeEach(() => {
  vi.mocked(reviewsApi.posts).mockResolvedValue([]);
  vi.mocked(reviewsApi.changes).mockResolvedValue([scheduled, { ...scheduled, id: 'other', location_id: 'loc2' }]);
  vi.mocked(reviewsApi.createPost).mockImplementation(async (_id, body) => ({ ...scheduled, id: 'c2', publish_at: (body as { publishAt?: string }).publishAt ?? null }));
  vi.mocked(reviewsApi.rejectChange).mockResolvedValue({ ...scheduled, status: 'rejected' });
});

it('schedules a post for a set time in the viewer\'s time zone', async () => {
  render(<BusinessPostsTab locations={[location]} locationId="loc1" canManage onPick={() => {}} reload={async () => {}} />);
  fireEvent.change(await screen.findByPlaceholderText("What's new, in plain words."), { target: { value: 'Winter roof checks from December.' } });
  fireEvent.change(screen.getByLabelText('Publish'), { target: { value: 'later' } });
  const when = screen.getByLabelText('Date and time (your time zone)') as HTMLInputElement;
  fireEvent.change(when, { target: { value: '2030-01-15T09:30' } });
  fireEvent.click(screen.getByRole('button', { name: /Schedule for/ }));
  await waitFor(() => expect(reviewsApi.createPost).toHaveBeenCalled());
  const body = vi.mocked(reviewsApi.createPost).mock.calls[0][1];
  expect(body).toMatchObject({ summary: 'Winter roof checks from December.', publishAt: new Date('2030-01-15T09:30').toISOString() });
  expect(toast).toHaveBeenCalledWith('success', expect.stringMatching(/^Scheduled for/));
});

it('lists this location\'s scheduled posts and cancels one', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<BusinessPostsTab locations={[location]} locationId="loc1" canManage onPick={() => {}} reload={async () => {}} />);
  expect(await screen.findByText('Gutter cleaning slots open next week.')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /Cancel/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
  await waitFor(() => expect(reviewsApi.rejectChange).toHaveBeenCalledWith('c1'));
});
