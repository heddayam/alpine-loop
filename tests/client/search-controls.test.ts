import { describe, expect, it } from "vitest";
import type { SearchQuery } from "../../src/model.js";
import {
  draftForQuery,
  initialDraft,
  queryForDraft,
  convertDraft,
} from "../../src/client/SearchControls.js";

describe("editable search constraints", () => {
  it("copies saved editable limits without rounding or changing the search scope", () => {
    const query: SearchQuery = {
      sections: ["alpine-lakes", "rainier"],
      boundary: [[-122, 47], [-121, 47], [-121, 48]],
      distance: [11265.408, 16093.44],
      gain: [670.56, 822.96],
      stem: 1612.994,
      includeUnknown: false,
      effort: "deep",
      roads: { distance: 1232.994, fraction: 0.35 },
    };
    const editableQuery = { ...query, repetition: 1, includeUnknown: true, roads: { ...query.roads!, fraction: 1 } };
    const draft = draftForQuery(query);
    expect(queryForDraft(draft)).toEqual(editableQuery);
    let converted = draft;
    for (let i = 0; i < 10; i++) {
      converted = convertDraft(converted, "imperial", "metric");
      expect(queryForDraft(converted, "metric")).toEqual(editableQuery);
      converted = convertDraft(converted, "metric", "imperial");
      expect(queryForDraft(converted)).toEqual(editableQuery);
    }
    draft.sections.pop();
    expect(query.sections).toEqual(["alpine-lakes", "rainier"]);
    draft.boundary![0]![0] = -123;
    expect(query.boundary![0]![0]).toBe(-122);
  });

  it("allows zero road and stem distance but rejects missing or invalid limits", () => {
    const draft = {
      ...initialDraft,
      sections: ["alpine-lakes"],
      roadDistance: "0",
      stem: "0",
    };
    expect(queryForDraft(draft)).toMatchObject({
      roads: { distance: 0, fraction: 1 },
      stem: 0,
    });
    for (const change of [
      { distance: ["", "12"] as [string, string] },
      { distance: ["5", "0"] as [string, string] },
      { gain: ["100", "50"] as [string, string] },
      { stem: "-1" },
      { stem: "" },
      { stemPercent: "" },
      { stemPercent: "101" },
      { stemPercent: "-1" },
      { roadDistance: "-1" },
    ])
      expect(() => queryForDraft({ ...draft, ...change })).toThrow();
    expect(() => queryForDraft({ ...draft, sections: [] })).toThrow(
      "Select at least one",
    );
  });

  it("preserves stem percentages through unit conversion and saved settings", () => {
    const draft = { ...initialDraft, sections: ["fixture"], stemPercent: "12.5" };
    const metric = convertDraft(draft, "imperial", "metric");
    expect(metric.stemPercent).toBe("12.5");
    const query = queryForDraft(metric, "metric");
    expect(query.repetition).toBe(0.125);
    expect(draftForQuery(query).stemPercent).toBe("12.5");
  });

  it("keeps blank inputs blank across unit changes and applies typed absolute limits", () => {
    const draft = { ...initialDraft, sections: ["fixture"], stem: "1.5", gain: ["", "4000"] as [string, string] };
    const metric = convertDraft(draft, "imperial", "metric");
    expect(metric.gain[0]).toBe("");
    expect(() => queryForDraft(metric, "metric")).toThrow();
    const valid = { ...metric, gain: ["0", metric.gain[1]] as [string, string] };
    expect(queryForDraft(valid, "metric").stem).toBe(1.5 * 1609.344);
    expect(queryForDraft({ ...valid, stem: "1" }, "metric").stem).toBe(1000);
  });

  it("omits disabled grade limits, keeps their values, and validates enabled limits", () => {
    const draft = { ...initialDraft, sections: ["fixture"] };
    expect(queryForDraft(draft)).not.toHaveProperty("grades");
    const enabled = { ...draft, grades: { ...draft.grades!, enabled: true } };
    expect(queryForDraft(enabled)).toMatchObject({ grades: {
      uphill: { above: 15, total: 0.5 * 1609.344, longest: 0.2 * 1609.344 },
      downhill: { above: 15, total: 0.25 * 1609.344, longest: 0.1 * 1609.344 },
    } });
    const invalid = { ...enabled, grades: { ...enabled.grades, uphill: { ...enabled.grades.uphill, total: "" } } };
    expect(() => queryForDraft(invalid)).toThrow("Grade thresholds");
    expect(queryForDraft({ ...invalid, grades: { ...invalid.grades, enabled: false } })).not.toHaveProperty("grades");
    const zero = { ...enabled, grades: { ...enabled.grades, uphill: { above: "0", total: "0", longest: "0" } } };
    expect(queryForDraft(zero)).toMatchObject({ grades: { uphill: { above: 0, total: 0, longest: 0 } } });
  });

  it("restores saved grade limits and preserves exact distances through unit changes", () => {
    const query = { ...queryForDraft({ ...initialDraft, sections: ["fixture"] }), grades: {
      uphill: { above: 12.5, total: 823.123456, longest: 234.56789 },
      downhill: { above: 17, total: 345.123456, longest: 123.456789 },
    } };
    let draft = draftForQuery(query);
    expect(draft.grades?.enabled).toBe(true);
    for (let i = 0; i < 5; i++) {
      draft = convertDraft(draft, "imperial", "metric");
      expect(queryForDraft(draft, "metric")).toEqual(query);
      draft = convertDraft(draft, "metric", "imperial");
      expect(queryForDraft(draft)).toEqual(query);
    }
    const edited = { ...draft, grades: { ...draft.grades!, uphill: { ...draft.grades!.uphill, total: "1" } } };
    expect(queryForDraft(edited)).toMatchObject({ grades: { uphill: { total: 1609.344 } } });
    const off = { ...draft, grades: { ...draft.grades!, enabled: false } };
    expect(convertDraft(off, "imperial", "metric").grades?.uphill.total).toBe("0.823");
  });

});
