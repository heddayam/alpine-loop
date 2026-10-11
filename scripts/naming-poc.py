"""Offline naming experiment, not production naming or route validation.

Run with tools/prepare/.venv/bin/python scripts/naming-poc.py
  --routes .local-data/naming-poc/routes.json
  --landmarks /tmp/alpine-naming-landmarks.geojsonseq
  --output .local-data/naming-poc/report.json

The route input is a copy fetched through the running app's GET endpoints.
Landmarks are exported from the same pinned Washington OSM snapshot using
osmium tags-filter (peaks, saddles, viewpoints, waterfalls, water=lake), then
osmium export --geometry-types=point,polygon --add-unique-id=type_id.
No search, prepared section, or saved result is modified.
"""
import argparse
import collections
import json
import math
import re
from pathlib import Path

from shapely.geometry import LineString, box, mapping, shape
from shapely.ops import nearest_points, transform
from shapely.strtree import STRtree


def short_name(name):
    name = re.sub(r'\s+(?:Trail|Route)(?:\s+#?[\w.]+)?$', '', name, flags=re.I)
    return name.strip()


def loop_title(names):
    title = '–'.join(short_name(name) for name in names)
    return title if title.lower().endswith('loop') else title + ' Loop'


def trail_title(names, features):
    names = [short_name(name) for name in names]
    places = {part.strip().casefold() for feature in features
              if feature['kind'] in ('summit', 'lake', 'pass')
              for part in feature['name'].split(' / ')}
    if any(name.casefold() in places for name in names):
        return 'Loop via ' + ' and '.join(names) + (' trails' if len(names) > 1 else ' Trail')
    return loop_title(names)


def read_features(path):
    result = []
    for line in path.read_text().splitlines():
        if not line.strip('\x1e \t'):
            continue
        feature = json.loads(line.lstrip('\x1e'))
        tags = feature['properties']
        if not tags.get('name'):
            continue
        kind = ('summit' if tags.get('natural') == 'peak' else
                'pass' if tags.get('natural') == 'saddle' else
                'lake' if tags.get('water') == 'lake' else
                'waterfall' if tags.get('waterway') == 'waterfall' else
                'viewpoint' if tags.get('tourism') == 'viewpoint' else None)
        geometry = shape(feature['geometry'])
        if not kind or geometry.is_empty or not geometry.is_valid:
            continue
        # Lake points do not establish shoreline access. Use actual polygons.
        if kind == 'lake' and geometry.geom_type not in ('Polygon', 'MultiPolygon'):
            continue
        if kind != 'lake' and geometry.geom_type != 'Point':
            continue
        result.append({'id': feature['id'], 'name': tags['name'], 'kind': kind,
                       'geometry': geometry, 'elevation': tags.get('ele')})
    return result


def analyze(route, features, tree):
    coordinates = route['geometry']
    origin_x, origin_y = coordinates[0][:2]
    scale_x = 111195 * math.cos(math.radians(origin_y))
    scale_y = 111195

    def project(x, y, z=None):
        try:
            return ([(v - origin_x) * scale_x for v in x],
                    [(v - origin_y) * scale_y for v in y])
        except TypeError:
            return ((x - origin_x) * scale_x, (y - origin_y) * scale_y)

    projected = [[(p[0] - origin_x) * scale_x, (p[1] - origin_y) * scale_y,
                  p[2] if len(p) > 2 else 0] for p in coordinates]
    full = LineString(projected)
    segments = route.get('segments', [])
    first, last = 0, len(segments) - 1
    while first < last and segments[first]['id'] == segments[last]['id']:
        first += 1
        last -= 1
    core_start = segments[first]['start'] if segments else 0
    core_end = segments[last]['end'] if segments else len(coordinates) - 1
    core = LineString(projected[core_start:core_end + 1])
    # Physical trail length, not repeated approach distance, selects fallback names.
    lengths = collections.Counter()
    seen = set()
    for segment in segments[first:last + 1]:
        name = segment.get('name')
        if segment['id'] in seen or name not in route['trailNames']:
            continue
        seen.add(segment['id'])
        lengths[name] += LineString(projected[segment['start']:segment['end'] + 1]).length
    ranked = sorted(lengths, key=lambda name: (-lengths[name], name.casefold()))
    if ranked:
        count = 1 if lengths[ranked[0]] >= core.length * .55 else 2
        fallback = trail_title(ranked[:count], features)
    elif route['trailNames']:
        fallback = trail_title(route['trailNames'][:2], features)
    else:
        fallback = 'Loop from ' + route['startName']
    west, south, east, north = full.bounds
    geographic_bounds = box(west / scale_x + origin_x - 300 / scale_x,
                            south / scale_y + origin_y - 300 / scale_y,
                            east / scale_x + origin_x + 300 / scale_x,
                            north / scale_y + origin_y + 300 / scale_y)
    matches = []
    for index in tree.query(geographic_bounds):
        feature = features[index]
        geometry = transform(project, feature['geometry'])
        target = geometry.boundary if feature['kind'] == 'lake' else geometry
        gap = core.distance(target)
        full_gap = full.distance(target)
        if min(gap, full_gap) > 250:
            continue
        on_loop = gap <= full_gap + 10
        line = core if on_loop else full
        near_route, near_feature = nearest_points(line, target)
        at = line.project(near_route)
        closest = line.interpolate(at)
        elevation_gap = None
        try:
            elevation_gap = abs(float(feature['elevation']) - closest.z)
        except (TypeError, ValueError):
            pass
        # Retain doubtful matches for inspection, but do not use them in titles.
        elevation_ok = feature['kind'] != 'summit' or elevation_gap is not None and elevation_gap <= 30
        xy = near_feature.coords[0]
        location = [xy[0] / scale_x + origin_x, xy[1] / scale_y + origin_y]
        match = {'id': feature['id'], 'name': feature['name'], 'kind': feature['kind'],
                 'distance': round(gap if on_loop else full_gap, 1), 'onLoop': on_loop,
                 'elevationGap': None if elevation_gap is None else round(elevation_gap, 1),
                 'elevationOK': elevation_ok, 'location': location,
                 'at': round(at), 'nearStart': math.hypot(*xy) < 500,
                 'geometry': mapping(feature['geometry'])}
        matches.append(match)
    # Same-name OSM objects can duplicate a feature. Keep its closest match.
    unique = {}
    for match in sorted(matches, key=lambda item: (not item['onLoop'], item['distance'], item['id'])):
        unique.setdefault((match['kind'], match['name']), match)
    matches = sorted(unique.values(), key=lambda item: (not item['onLoop'], item['distance'], item['name']))
    proposals = {}
    for radius in (50, 100, 200):
        eligible = [item for item in matches if item['onLoop'] and item['distance'] <= radius
                    and item['elevationOK']
                    and item['kind'] in ('lake', 'pass', 'summit')]
        # Up to two separated places, so a lake and its adjacent summit aren't
        # counted as two independent anchors purely due to map proximity.
        selected = []
        for candidate in eligible:
            if all(min(abs(candidate['at'] - previous['at']),
                       core.length - abs(candidate['at'] - previous['at'])) >= 500 for previous in selected):
                selected.append(candidate)
            if len(selected) == 2:
                break
        selected.sort(key=lambda item: item['name'].casefold())
        proposals[str(radius)] = {'title': loop_title([item['name'] for item in selected]) if selected else fallback,
                                 'landmarks': [item['id'] for item in selected]}
    # Simplify drawings for interactive review only, never the analysis above.
    simplified = []
    for point in full.simplify(12).coords:
        simplified.append([round(point[0] / scale_x + origin_x, 6),
                           round(point[1] / scale_y + origin_y, 6)])
    start = coordinates[core_start]
    return {'id': route['id'], 'jobId': route['jobId'], 'region': route['region'],
            'current': ' / '.join(route['trailNames'][:2]) or route['startName'],
            'trailTitle': fallback, 'trailNames': route['trailNames'],
            'distance': round(route['distance'] / 1609.344, 1), 'gain': round(route['gain'] * 3.28084),
            'startName': route['startName'], 'start': coordinates[0][:2],
            'coreStart': start[:2], 'geometry': simplified,
            'matches': matches, 'proposals': proposals}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--routes', type=Path, required=True)
    parser.add_argument('--landmarks', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    features = read_features(args.landmarks)
    tree = STRtree([feature['geometry'] for feature in features])
    results = [analyze(route, features, tree) for route in json.loads(args.routes.read_text())]
    stats = {'routes': len(results), 'namedLandmarkObjects': len(features),
             'landmarkTitles': {radius: sum(bool(route['proposals'][radius]['landmarks']) for route in results)
                                for radius in ('50', '100', '200')},
             'nearbySummitsRejectedByElevation': sum(sum(match['kind'] == 'summit' and not match['elevationOK']
                                                       for match in route['matches']) for route in results)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'stats': stats, 'routes': results}))
    print(json.dumps(stats))
    for route in results:
        if route['matches']:
            print(json.dumps({'current': route['current'], 'proposed': route['proposals']['100']['title'],
                              'mi': route['distance'], 'matches': [{key: match[key] for key in
                               ('name', 'kind', 'distance', 'onLoop', 'elevationGap', 'elevationOK', 'nearStart')}
                               for match in route['matches'][:6]]}))


if __name__ == '__main__':
    main()
