import { describe, expect, it } from 'vitest';
import { parseQuery, RequestError } from '../../src/jobs.js';
import { query } from './network-fixture.js';

const grades = { uphill: { above: 15, total: 800, longest: 300 }, downhill: { above: 12, total: 400, longest: 100 } };

describe('immutable grade search criteria', () => {
  it('retains both directional limits without references to the submitted object', () => {
    const parsed = parseQuery({ ...query, grades });
    expect(parsed.grades).toEqual(grades);
    expect(parsed.grades).not.toBe(grades);
    expect(parsed.grades!.uphill).not.toBe(grades.uphill);
    expect(parseQuery(query)).not.toHaveProperty('grades');
  });

  it('rejects malformed, missing and nonfinite directional fields', () => {
    for (const invalid of [null, [], {}, { uphill: grades.uphill },
      ...[-1, NaN, Infinity, '15', null, undefined].map(above => ({ ...grades, uphill: { ...grades.uphill, above } })),
      { ...grades, downhill: { ...grades.downhill, longest: -1 } },
      { ...grades, downhill: { ...grades.downhill, total: Infinity } },
    ]) expect(() => parseQuery({ ...query, grades: invalid })).toThrow(RequestError);
  });
});
