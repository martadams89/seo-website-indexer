/**
 * reviews/media-check.ts — look at a photo or video address before handing it
 * to Google, so a bad link fails with a clear reason straight away instead of
 * an opaque error from Google later (or a broken item in the gallery).
 *
 * Google downloads the file itself, so this only reads the headers: a web page
 * instead of the file, a missing file, the wrong type, or a size outside
 * Google's limits. Anything this server can't tell (it can't reach the host,
 * the host doesn't say) is left for Google to judge.
 */
import { safeFetch } from '../security/outbound-url.js';
import { ProfileInputError, type MediaFormat } from './profile-rules.js';

/** Google Business Profile limits: photos 10 KB–5 MB (JPG or PNG), videos up to 75 MB. */
export const MEDIA_LIMITS = { PHOTO: { min: 10 * 1024, max: 5 * 1024 * 1024 }, VIDEO: { min: 1, max: 75 * 1024 * 1024 } } as const;

export interface MediaCheck { checked: boolean; bytes: number | null; content_type: string | null }

type Probe = (url: string, init: RequestInit) => Promise<Response>;
let probe: Probe | null = null;
/** Tests inject the HTTP side; without one, tests skip the check rather than reach the network. */
export function __setMediaProbeForTests(next: Probe | null): void { probe = next; }

const send: Probe = (url, init) => (probe ?? ((u, i) => safeFetch(u, i, { label: 'Photo or video address' })))(url, { ...init, signal: AbortSignal.timeout(10_000) });
const size = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export async function checkMediaSource(url: string, format: MediaFormat): Promise<MediaCheck> {
  if (!probe && process.env.NODE_ENV === 'test') return { checked: false, bytes: null, content_type: null };
  let res: Response;
  try {
    res = await send(url, { method: 'HEAD', redirect: 'follow' });
    // Some hosts don't answer HEAD: ask for the first byte instead.
    if (res.status === 405 || res.status === 501) res = await send(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
  } catch {
    return { checked: false, bytes: null, content_type: null };
  }
  const noun = format === 'VIDEO' ? 'video' : 'photo';
  if ([401, 403, 404, 410].includes(res.status)) {
    throw new ProfileInputError(`The ${noun} address answered HTTP ${res.status}, so Google won't be able to download it either. Use a public link to the file itself.`);
  }
  if (!res.ok) return { checked: false, bytes: null, content_type: null };

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() || null;
  if (type?.startsWith('text/') || type === 'application/json') {
    throw new ProfileInputError(`That address is a web page (${type}), not the ${noun} itself. Use the direct link to the file (it usually ends in ${format === 'VIDEO' ? '.mp4 or .mov' : '.jpg or .png'}).`);
  }
  if (format === 'PHOTO' && type?.startsWith('video/')) throw new ProfileInputError('That address is a video. Add it as a video (format "video").');
  if (format === 'VIDEO' && type?.startsWith('image/')) throw new ProfileInputError('That address is an image. Add it as a photo.');
  if (format === 'PHOTO' && type?.startsWith('image/') && !['image/jpeg', 'image/jpg', 'image/png'].includes(type)) {
    throw new ProfileInputError(`Google Business Profile takes JPG or PNG photos; this one is ${type}. Convert it first.`);
  }

  // A ranged GET reports the full size in Content-Range ("bytes 0-0/12345").
  const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
  const length = total ? Number(total) : res.status === 206 ? null : Number(res.headers.get('content-length') ?? NaN);
  const bytes = length !== null && Number.isFinite(length) && length > 0 ? length : null;
  if (bytes !== null) {
    const limits = MEDIA_LIMITS[format];
    if (bytes < limits.min) throw new ProfileInputError(`The ${noun} is only ${size(bytes)}; Google needs at least ${size(limits.min)} (and 250×250 pixels).`);
    if (bytes > limits.max) throw new ProfileInputError(`The ${noun} is ${size(bytes)}; Google takes ${format === 'VIDEO' ? 'videos' : 'photos'} up to ${size(limits.max)}.`);
  }
  return { checked: true, bytes, content_type: type };
}
