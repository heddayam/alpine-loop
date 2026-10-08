import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CatalogView, SectionView } from '../../src/data-format.js';
import { CatalogAreas } from '../../src/client/CatalogAreas.js';

const section = (id: string, state: string, regionId: string, regionName: string, name: string, installed = false): SectionView => ({
  id, state, regionId, regionName, name, installed, bytes: 5000, sourceSegments: 1, startCount: 1,
  bounds: [-123, 37, -121, 49], boundary: { type: 'MultiPolygon', coordinates: [] }, files: {} as SectionView['files'],
});
const catalog: CatalogView = {
  id: 'fixture', name: 'Fixture', sourceDate: '2026-08-01', bounds: [-123, 37, -121, 49], attribution: [], limitations: [], startCount: 4,
  sections: [section('alpine', 'WA', 'cascades', 'Cascades', 'Alpine Lakes', true),
    section('rainier', 'WA', 'cascades', 'Cascades', 'Mount Rainier'),
    section('olympic', 'WA', 'olympics', 'Olympic Mountains', 'Olympic Mountains'),
    section('santa-cruz', 'CA', 'santa-cruz', 'Santa Cruz Mountains', 'Santa Cruz Mountains')],
};
const render = (dataset: CatalogView, purpose: 'search' | 'download') => renderToStaticMarkup(createElement(CatalogAreas, {
  dataset, purpose, value: [], onChange() {},
}));

describe('shared state-first area list', () => {
  it('uses the same state/range hierarchy in search and Settings without redundant singleton headings', () => {
    for (const purpose of ['search', 'download'] as const) {
      const html = render(catalog, purpose);
      expect(html.match(/<h4>/g)).toHaveLength(2);
      expect(html.match(/<h5>/g)).toHaveLength(1);
      expect(html).toContain('<h5>Cascades</h5>');
      expect(html.match(/>Olympic Mountains</g)).toHaveLength(1);
      expect(html.match(/>Santa Cruz Mountains</g)).toHaveLength(1);
      expect(html.indexOf('>California</h4>')).toBeLessThan(html.indexOf('>Washington</h4>'));
    }
    expect(render(catalog, 'search').match(/type="checkbox"/g)).toHaveLength(4);
    const downloads = render(catalog, 'download');
    expect(downloads.match(/type="checkbox"/g)).toHaveLength(3);
    expect(downloads).toContain('>Ready</span>');
    expect(downloads).toContain('5 KB');
  });

  it('groups by explicit geography despite names and keeps unavailable areas in their actual state and range', () => {
    const prepared = section('ridge', 'WA', 'ridge', 'Highlands', 'California — Ridge');
    const unavailable = { ...prepared, name: 'Future section', reason: 'Not prepared' };
    const { files, ...area } = unavailable;
    const html = render({ ...catalog, sections: [prepared], unavailable: [area] }, 'download');
    expect(html).toContain('<h4>Washington</h4>');
    expect(html).not.toContain('<h4>California</h4>');
    expect(html).toContain('<h5>Highlands</h5>');
    expect(html).toContain('title="Not prepared"');
    expect(html).toContain('>Unavailable</span>');
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
  });
});
