import { describe, it, expect, afterEach } from 'vitest';
import { checkMediaSource, __setMediaProbeForTests } from '../reviews/media-check.js';
import { mediaFormatOf, validatePhoto } from '../reviews/profile-rules.js';

// Photo and video links are checked before Google sees them: web pages, missing
// files, the wrong type and sizes outside Google's limits fail with a reason;
// anything the server can't tell is left for Google.
const headers = (h: Record<string, string>) => ({ headers: new Headers(h) });
function answer(status: number, h: Record<string, string> = {}, onCall?: (init: RequestInit) => void) {
  __setMediaProbeForTests(async (_url, init) => { onCall?.(init); return new Response(null, { status, ...headers(h) }); });
}
afterEach(() => __setMediaProbeForTests(null));

describe('photo and video links', () => {
  it('works out videos from the address, and keeps them off cover, profile and logo', () => {
    expect(mediaFormatOf('https://cdn.test/job/van.MP4?x=1')).toBe('VIDEO');
    expect(mediaFormatOf('https://cdn.test/job/roof.jpg')).toBe('PHOTO');
    expect(mediaFormatOf('https://cdn.test/media/123', 'video')).toBe('VIDEO');
    expect(validatePhoto({ url: 'https://cdn.test/a.mov', category: 'AT_WORK' }).mediaFormat).toBe('VIDEO');
    expect(() => validatePhoto({ url: 'https://cdn.test/a.mp4', category: 'LOGO' })).toThrow(/can't be the cover, profile or logo/);
  });

  it('accepts a JPG of a sensible size', async () => {
    answer(200, { 'content-type': 'image/jpeg', 'content-length': String(800 * 1024) });
    expect(await checkMediaSource('https://cdn.test/a.jpg', 'PHOTO')).toEqual({ checked: true, bytes: 800 * 1024, content_type: 'image/jpeg' });
  });

  it('explains a web page, a missing file, the wrong type and sizes outside Google\'s limits', async () => {
    answer(200, { 'content-type': 'text/html; charset=utf-8' });
    await expect(checkMediaSource('https://cdn.test/post/1', 'PHOTO')).rejects.toThrow(/web page/);
    answer(404);
    await expect(checkMediaSource('https://cdn.test/gone.jpg', 'PHOTO')).rejects.toThrow(/HTTP 404/);
    answer(200, { 'content-type': 'image/webp', 'content-length': '50000' });
    await expect(checkMediaSource('https://cdn.test/a.webp', 'PHOTO')).rejects.toThrow(/JPG or PNG/);
    answer(200, { 'content-type': 'video/mp4' });
    await expect(checkMediaSource('https://cdn.test/a', 'PHOTO')).rejects.toThrow(/is a video/);
    answer(200, { 'content-type': 'image/png', 'content-length': '2048' });
    await expect(checkMediaSource('https://cdn.test/tiny.png', 'PHOTO')).rejects.toThrow(/only 2 KB/);
    answer(200, { 'content-type': 'image/jpeg', 'content-length': String(6 * 1024 * 1024) });
    await expect(checkMediaSource('https://cdn.test/huge.jpg', 'PHOTO')).rejects.toThrow(/6.0 MB/);
    answer(200, { 'content-type': 'video/mp4', 'content-length': String(80 * 1024 * 1024) });
    await expect(checkMediaSource('https://cdn.test/long.mp4', 'VIDEO')).rejects.toThrow(/up to 75.0 MB/);
  });

  it('asks for one byte when a host won\'t answer HEAD, and reads the size from Content-Range', async () => {
    const methods: string[] = [];
    __setMediaProbeForTests(async (_url, init) => {
      methods.push(String(init.method));
      return init.method === 'HEAD'
        ? new Response(null, { status: 405 })
        : new Response('x', { status: 206, ...headers({ 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/31457280' }) });
    });
    expect(await checkMediaSource('https://cdn.test/job.mp4', 'VIDEO')).toMatchObject({ checked: true, bytes: 31457280 });
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it('leaves it to Google when the host can\'t be reached or doesn\'t say', async () => {
    __setMediaProbeForTests(async () => { throw new Error('ECONNRESET'); });
    expect((await checkMediaSource('https://cdn.test/a.jpg', 'PHOTO')).checked).toBe(false);
    answer(503);
    expect((await checkMediaSource('https://cdn.test/a.jpg', 'PHOTO')).checked).toBe(false);
    answer(200, { 'content-type': 'application/octet-stream' });
    expect(await checkMediaSource('https://cdn.test/a.jpg', 'PHOTO')).toMatchObject({ checked: true, bytes: null });
  });
});
