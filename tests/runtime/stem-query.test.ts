import { describe, expect, it } from 'vitest';
import { parseQuery, RequestError } from '../../src/jobs.js';

const query = { sections: ['fixture'], distance: [1_000, 10_000], gain: [0, 1_000], stem: 1_609.344, includeUnknown: true };

describe('persisted stem search constraints', () => {
  it('keeps the absolute distance without converting it to a route-length fraction', () => {
    const parsed = parseQuery(query);
    expect(parsed.stem).toBe(1_609.344);
    expect(parsed).not.toHaveProperty('repetition');
    expect(parsed.sections).not.toBe(query.sections);
    expect(parsed.distance).not.toBe(query.distance);
    expect(parseQuery({ ...query, stem: 0 }).stem).toBe(0);
    expect(parseQuery({ ...query, stem: 30_000 }).stem).toBe(30_000);
  });

  it('preserves legacy limits for immutable saved and queued searches', () => {
    const parsed = parseQuery({ ...query, stem: undefined, repetition: 0.2 });
    expect(parsed.repetition).toBe(0.2);
    expect(parsed).not.toHaveProperty('stem');
  });

  it('rejects conflicting, absent, malformed and nonfinite limits', () => {
    for (const value of [
      { ...query, stem: undefined }, { ...query, repetition: 0.2 },
      ...[-1, NaN, Infinity, '1', null].map(stem => ({ ...query, stem })),
      ...[-1, 1.1, NaN, Infinity, '0.2', null].map(repetition => ({ ...query, stem: undefined, repetition })),
    ]) {
      try { parseQuery(value); throw new Error('Invalid constraints accepted'); }
      catch (error) { expect(error).toBeInstanceOf(RequestError); expect((error as RequestError).statusCode).toBe(400); }
    }
  });
});
