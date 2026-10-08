import { describe, expect, it } from "vitest";
import { elevationGrade, gradeExposure, type ProfileSample } from "../../src/grade.js";

const samples = (points: [number, number?][]): ProfileSample[] =>
  points.map(([distance, height]) => ({ distance, position: height === undefined ? [0, 0] : [0, 0, height] }));
const limits = { uphill: 20, downhill: 20 };

describe("100 m grade exposure", () => {
  it("integrates exact threshold crossings instead of rounding to geometry vertices", () => {
    const walk = samples([[0, 0], [100, 0], [200, 40], [300, 40]]);
    const result = gradeExposure(walk, limits)!;
    // Windows exceed 20% only with centers strictly between 100 and 200 m.
    expect(result.uphill.total).toBeCloseTo(100, 10);
    expect(result.uphill.longest).toBeCloseTo(100, 10);
    expect(result.downhill).toEqual({ total: 0, longest: 0 });
    expect(elevationGrade(walk, 100)).toBe(20);
    expect(elevationGrade(walk, 150)).toBe(40);
  });

  it("handles clipped windows and excludes grade exactly at the threshold", () => {
    expect(gradeExposure(samples([[0, 0], [40, 6]]), { uphill: 15, downhill: 15 }))
      .toEqual({ uphill: { total: 0, longest: 0 }, downhill: { total: 0, longest: 0 } });
    const result = gradeExposure(samples([[0, 0], [100, 40], [200, 40]]), limits)!;
    expect(result.uphill.total).toBeCloseTo(100, 10);
    expect(result.uphill.longest).toBeCloseTo(100, 10);
    expect(gradeExposure(samples([[0, 0], [40, 8]]), { uphill: 15, downhill: 15 })!.uphill)
      .toEqual({ total: 40, longest: 40 });
  });

  it("solves crossings within endpoint clipping where grade is a ratio of linear functions", () => {
    // For centers 0..50, grade = 100 * 10 / (center + 50).
    // The 15% crossing is 50/3 m; using linear interpolation of grade is incorrect.
    const result = gradeExposure(samples([[0, 0], [25, 10], [150, 10]]), { uphill: 15, downhill: 15 })!;
    expect(result.uphill.total).toBeCloseTo(50 / 3, 10);
    expect(result.uphill.longest).toBeCloseTo(50 / 3, 10);
  });

  it("counts repeated passes separately and preserves continuous runs across trail joins", () => {
    const walk = samples([[0, 0], [80, 16], [200, 40], [400, 0], [600, 40], [800, 0]]);
    const result = gradeExposure(walk, { uphill: 10, downhill: 10 })!;
    expect(result.uphill.total).toBeCloseTo(325, 10);
    expect(result.uphill.longest).toBeCloseTo(175, 10);
    expect(result.downhill.total).toBeCloseTo(325, 10);
    expect(result.downhill.longest).toBeCloseTo(175, 10);
  });

  it("keeps direction thresholds separate and swaps exposure on reversed walks", () => {
    const walk = samples([[0, 0], [100, 0], [200, 40], [300, 40]]);
    const reversed = [...walk].reverse().map((sample) => ({ ...sample, distance: 300 - sample.distance }));
    const forward = gradeExposure(walk, { uphill: 10, downhill: 30 })!;
    const backward = gradeExposure(reversed, { uphill: 30, downhill: 10 })!;
    expect(forward.uphill.total).toBeCloseTo(150, 10);
    expect(backward.downhill).toEqual(forward.uphill);
    expect(backward.uphill).toEqual(forward.downhill);
  });

  it("does not miss a narrow pitch between samples or breakpoints", () => {
    const result = gradeExposure(samples([[0, 0], [100, 0], [101, 21], [300, 21]]), limits)!;
    // Rise must exceed 20 m; crossing centers are 50 + 20/21 and 151 - 20/21.
    expect(result.uphill.total).toBeCloseTo(101 - 40 / 21, 10);
  });

  it("accepts redundant duplicate samples and rejects unknown or malformed data", () => {
    const walk = samples([[0, 0], [0, 0], [100, 40], [100, 40], [200, 40], [200, 40]]);
    expect(gradeExposure(walk, limits)!.uphill.total).toBeCloseTo(100, 10);
    expect(gradeExposure(samples([[0, 0], [100], [200, 40]]), limits)).toBeNull();
    expect(gradeExposure(samples([[0, 0], [100, NaN]]), limits)).toBeNull();
    expect(gradeExposure(samples([[0, 0], [100, 10], [90, 20]]), limits)).toBeNull();
    expect(gradeExposure([], limits)).toBeNull();
    expect(gradeExposure(samples([[0, 0], [0, 0]]), limits)!.uphill.total).toBe(0);
  });

  it("matches independent midpoint integration on an irregular profile", () => {
    const points: [number, number][] = [[0, 3], [13, 9], [71, 8], [109, 26],
      [202, 27], [243, 10], [317, 5], [382, 28], [491, 3]];
    const height = (distance: number) => {
      const index = points.findIndex(([x]) => x >= distance);
      if (index === 0) return points[0]![1];
      const [x, y] = points[index]!;
      const [previousX, previousY] = points[index - 1]!;
      return previousY + (y - previousY) * (distance - previousX) / (x - previousX);
    };
    const thresholds = { uphill: 13, downhill: 19 };
    const expected = { uphill: { total: 0, longest: 0 }, downhill: { total: 0, longest: 0 } };
    const run = { uphill: 0, downhill: 0 };
    const length = points.at(-1)![0];
    const step = length / 40_000;
    for (let i = 0; i < 40_000; i++) {
      const center = (i + 0.5) * step;
      const start = Math.max(0, center - 50), end = Math.min(length, center + 50);
      const grade = 100 * (height(end) - height(start)) / (end - start);
      for (const direction of ['uphill', 'downhill'] as const) {
        if ((direction === 'uphill' ? grade : -grade) > thresholds[direction]) {
          expected[direction].total += step;
          run[direction] += step;
          expected[direction].longest = Math.max(expected[direction].longest, run[direction]);
        } else run[direction] = 0;
      }
    }
    const actual = gradeExposure(samples(points), thresholds)!;
    for (const direction of ['uphill', 'downhill'] as const) {
      expect(Math.abs(actual[direction].total - expected[direction].total)).toBeLessThan(0.05);
      expect(Math.abs(actual[direction].longest - expected[direction].longest)).toBeLessThan(0.05);
    }
  });
});
