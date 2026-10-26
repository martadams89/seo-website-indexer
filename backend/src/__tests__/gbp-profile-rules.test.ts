import { describe, it, expect } from 'vitest';
import {
  buildLocalPost, buildProfilePatch, DEFAULT_PROFILE_RULES, evaluatePhoto, fieldsFromMask, fromGoogleRegularHours, fromGoogleSpecialHours,
  normalizeProfileRules, toGoogleRegularHours, toGoogleSpecialHours, validatePhoto,
} from '../reviews/profile-rules.js';

describe('opening hours', () => {
  it('round-trips a normal day, an overnight shift and an all-day opening', () => {
    const google = toGoogleRegularHours([
      { day: 'FRIDAY', open: '18:00', close: '02:00' },
      { day: 'MONDAY', open: '09:00', close: '17:30' },
      { day: 'SUNDAY', open: '00:00', close: '24:00' },
    ]);
    expect(google.periods[0]).toEqual({ openDay: 'FRIDAY', openTime: { hours: 18, minutes: 0 }, closeDay: 'SATURDAY', closeTime: { hours: 2, minutes: 0 } });
    expect(google.periods[2]).toMatchObject({ openDay: 'SUNDAY', closeDay: 'SUNDAY', closeTime: { hours: 24 } });
    expect(fromGoogleRegularHours(google)).toEqual([
      { day: 'MONDAY', open: '09:00', close: '17:30' },
      { day: 'FRIDAY', open: '18:00', close: '02:00' },
      { day: 'SUNDAY', open: '00:00', close: '24:00' },
    ]);
  });

  it('reads Google\'s omitted zero fields as midnight and on-the-hour', () => {
    expect(fromGoogleRegularHours({ periods: [{ openDay: 'TUESDAY', openTime: {}, closeDay: 'TUESDAY', closeTime: { hours: 12 } }] }))
      .toEqual([{ day: 'TUESDAY', open: '00:00', close: '12:00' }]);
  });

  it('rejects bad days and times', () => {
    expect(() => toGoogleRegularHours([{ day: 'FUNDAY' as never, open: '09:00', close: '17:00' }])).toThrow(/needs a day/);
    expect(() => toGoogleRegularHours([{ day: 'MONDAY', open: '9am', close: '17:00' }])).toThrow(/time like 09:00/);
    expect(() => toGoogleRegularHours([{ day: 'MONDAY', open: '09:00', close: '24:30' }])).toThrow(/time like/);
  });

  it('handles closed holidays, short days and impossible dates', () => {
    const google = toGoogleSpecialHours([{ date: '2026-12-25', closed: true }, { date: '2026-12-24', closed: false, open: '09:00', close: '13:00' }]);
    expect(google.specialHourPeriods[0]).toEqual({ startDate: { year: 2026, month: 12, day: 25 }, closed: true });
    expect(fromGoogleSpecialHours(google)).toEqual([
      { date: '2026-12-24', closed: false, open: '09:00', close: '13:00' },
      { date: '2026-12-25', closed: true },
    ]);
    expect(() => toGoogleSpecialHours([{ date: '2026-02-30', closed: true }])).toThrow(/date like/);
  });
});

describe('profile edits', () => {
  it('keeps additional phone numbers when the main one changes', () => {
    const { body, mask } = buildProfilePatch({ primary_phone: '+44 20 7946 0000' }, { name: 'locations/1', phoneNumbers: { primaryPhone: '+44 1', additionalPhones: ['+44 2'] } });
    expect(mask).toEqual(['phoneNumbers']);
    expect(body.phoneNumbers).toEqual({ primaryPhone: '+44 20 7946 0000', additionalPhones: ['+44 2'] });
  });

  it('refuses descriptions over 750 characters, bad websites and empty edits', () => {
    expect(() => buildProfilePatch({ description: 'x'.repeat(751) }, { name: 'locations/1' })).toThrow(/750/);
    expect(() => buildProfilePatch({ website: 'roof.example' }, { name: 'locations/1' })).toThrow(/https/);
    expect(() => buildProfilePatch({}, { name: 'locations/1' })).toThrow(/Nothing to change/);
  });
});

describe('posts and photos', () => {
  it('builds an offer with its schedule and coupon', () => {
    const post = buildLocalPost({ topic: 'OFFER', event_title: 'Winter check', start_date: '2026-11-01', end_date: '2026-11-30', coupon_code: 'WINTER', cta_type: 'BOOK', cta_url: 'https://roof.example/book' });
    expect(post).toMatchObject({
      topicType: 'OFFER', callToAction: { actionType: 'BOOK', url: 'https://roof.example/book' },
      event: { title: 'Winter check', schedule: { startDate: { year: 2026, month: 11, day: 1 }, endDate: { year: 2026, month: 11, day: 30 } } },
      offer: { couponCode: 'WINTER' },
    });
  });

  it('refuses buttons without links, end dates before start dates and over-long text', () => {
    expect(() => buildLocalPost({ summary: 'Hi', cta_type: 'LEARN_MORE' })).toThrow(/link/);
    expect(() => buildLocalPost({ topic: 'EVENT', event_title: 'Open day', start_date: '2026-11-02', end_date: '2026-11-01' })).toThrow(/before the start/);
    expect(() => buildLocalPost({ summary: 'x'.repeat(1501) })).toThrow(/1500/);
  });

  it('checks photo URLs and categories, and holds brand photos', () => {
    expect(validatePhoto({ url: 'https://roof.example/a.jpg' })).toEqual({ sourceUrl: 'https://roof.example/a.jpg', category: 'ADDITIONAL' });
    expect(() => validatePhoto({ url: 'file:///tmp/a.jpg' })).toThrow(/https/);
    expect(() => validatePhoto({ url: 'https://roof.example/a.jpg', category: 'SELFIE' as never })).toThrow(/category/);
    expect(evaluatePhoto({ ...DEFAULT_PROFILE_RULES, photos: 'auto' }, { category: 'COVER' }).map(f => f.code)).toEqual(['identity_photo']);
    expect(evaluatePhoto({ ...DEFAULT_PROFILE_RULES, photos: 'auto' }, { category: 'INTERIOR' })).toEqual([]);
  });
});

describe('rules and labels', () => {
  it('falls back to approval for unknown modes', () => {
    expect(normalizeProfileRules({ profile: 'yolo', posts: 'auto', alert_google_updates: false })).toEqual({ profile: 'approval', posts: 'auto', photos: 'approval', alert_google_updates: false });
  });

  it('names Google\'s fields in plain words, once each', () => {
    expect(fieldsFromMask('phoneNumbers.primaryPhone,phoneNumbers,regularHours,categories.additionalCategories,somethingNew')).toEqual(['phone number', 'opening hours', 'additional categories', 'somethingNew']);
  });
});
