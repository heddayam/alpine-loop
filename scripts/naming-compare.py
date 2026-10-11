"""Compare a simple trail-first naming rule with the saved naming POC.

Offline only. Inputs are copied saved routes and the previous POC report.
Outputs never change saved jobs or production names. The same 100 m horizontal
and 30 m summit elevation tolerances are used, so this compares name selection,
not a new claim that map proximity proves a visit.
"""
import argparse
import collections
import json
import math
import runpy
from pathlib import Path

from shapely.geometry import LineString, Point, shape
from shapely.ops import nearest_points, transform

helpers = runpy.run_path(str(Path(__file__).with_name('naming-poc.py')))
loop_title = helpers['loop_title']
short_name = helpers['short_name']
trail_title = helpers['trail_title']


def arrival_distance(line, target, radius):
    """Shortest walking distance from the start in either direction.

    Use entry into the same match tolerance, including repeated visits, rather
    than the first occurrence of a nearest coordinate. This is direction-neutral.
    """
    nearby = line.intersection(target.buffer(radius + .001))
    pieces = list(nearby.geoms) if hasattr(nearby, 'geoms') else [nearby]
    distances = []
    reverse = LineString(list(line.coords)[::-1])
    for piece in pieces:
        if piece.is_empty:
            continue
        for point in (piece.coords[0], piece.coords[-1]):
            distances.extend((line.project(Point(point)), reverse.project(Point(point))))
    return min(distances) if distances else 0


def analyze(route, previous, features):
    coordinates = route['geometry']
    ox, oy = coordinates[0][:2]
    sx, sy = 111195 * math.cos(math.radians(oy)), 111195

    def project(x, y, z=None):
        return ([(v - ox) * sx for v in x], [(v - oy) * sy for v in y])

    points = [((p[0] - ox) * sx, (p[1] - oy) * sy, p[2]) for p in coordinates]
    full = LineString(points)
    segments = route['segments']
    first, last = 0, len(segments) - 1
    while first < last and segments[first]['id'] == segments[last]['id']:
        first += 1
        last -= 1
    core = LineString(points[segments[first]['start']:segments[last]['end'] + 1])
    lengths, seen = collections.Counter(), set()
    for segment in segments[first:last + 1]:
        name = segment.get('name')
        if not name or segment['id'] in seen:
            continue
        seen.add(segment['id'])
        lengths[name] += LineString(points[segment['start']:segment['end'] + 1]).length
    ranked = sorted(lengths, key=lambda name: (-lengths[name], name.casefold()))
    # Merge only spelling variants removed by the stated number/suffix cleanup.
    clean_lengths = collections.Counter()
    for name in ranked:
        clean = short_name(name)
        clean_lengths[clean] += lengths[name]
    ranked = sorted(clean_lengths, key=lambda name: (-clean_lengths[name], name.casefold()))
    share = clean_lengths[ranked[0]] / core.length if ranked else 0
    elevations = {feature['id']: feature['elevation'] for feature in features}
    eligible, reached_names = [], set()
    for match in previous['matches']:
        if match['kind'] not in ('lake', 'summit', 'pass'):
            continue
        geometry = transform(project, shape(match['geometry']))
        target = geometry.boundary if match['kind'] == 'lake' else geometry
        gap = full.distance(target)
        if gap > 100:
            continue
        closest = full.interpolate(full.project(nearest_points(full, target)[0]))
        # Same summit elevation tolerance, evaluated on the whole hike.
        if match['kind'] == 'summit':
            try:
                elevation_gap = abs(float(elevations[match['id']]) - closest.z)
            except (KeyError, TypeError, ValueError):
                continue
            if elevation_gap > 30:
                continue
        reached_names.update(part.strip().casefold() for part in match['name'].split(' / '))
        if match['kind'] == 'pass':
            continue
        eligible.append({**match, 'fullDistance': round(gap, 1),
                         'walkingDistance': round(arrival_distance(full, target, 100), 3)})
    eligible.sort(key=lambda item: (-item['walkingDistance'], item['name'].casefold()))
    # A trail bearing a summit's name is explicitly labelled as a trail unless
    # that summit also passes the visit gate. Reached places allow ordinary titles.
    unreached_features = [feature for feature in features
                          if not any(part.strip().casefold() in reached_names
                                     for part in feature['name'].split(' / '))]
    if ranked and share > .5:
        title = trail_title(ranked[:1], unreached_features)
        reason = 'majority-trail'
        chosen = []
    elif eligible:
        chosen = eligible[:1]
        title = loop_title([chosen[0]['name']])
        reason = 'destination'
    else:
        chosen = []
        title = trail_title(ranked[:2], unreached_features) if ranked else 'Loop from ' + route['startName']
        reason = 'two-trails' if ranked else 'start'
    return {'id': route['id'], 'jobId': route['jobId'], 'groupId': route['groupId'],
            'start': coordinates[0][:2], 'current': previous['current'],
            'previous': previous['proposals']['100']['title'], 'baseTitle': title,
            'title': title, 'reason': reason, 'majorityShare': round(share, 4),
            'rankedTrails': [{'name': name, 'meters': round(clean_lengths[name], 1)} for name in ranked],
            'landmarks': [item['id'] for item in chosen],
            'eligibleDestinations': [{key: item[key] for key in
                                     ('id', 'name', 'kind', 'onLoop', 'fullDistance', 'walkingDistance')}
                                    for item in eligible], 'qualified': False}


def nearby(a, b):
    x, y = a['start'], b['start']
    return math.hypot((x[0] - y[0]) * 111195 * math.cos(math.radians((x[1] + y[1]) / 2)),
                      (x[1] - y[1]) * 111195) <= 5000


def qualify(results):
    # Compare actual distinct circuits within a saved result set. Multiple
    # variants of the same circuit do not alone trigger a naming qualifier.
    groups = collections.defaultdict(list)
    for result in results:
        groups[result['jobId'], result['baseTitle'].casefold()].append(result)
    for group in groups.values():
        for result in group:
            collision = any(other['groupId'] != result['groupId'] and nearby(result, other)
                            for other in group)
            trails = result['rankedTrails']
            if not collision or not trails:
                continue
            if result['reason'] == 'destination':
                qualifier = trails[0]['name']
            elif result['reason'] == 'majority-trail' and len(trails) > 1:
                qualifier = trails[1]['name']
            else:
                continue
            if qualifier.casefold() in result['baseTitle'].casefold():
                continue
            result['title'] += ' via ' + qualifier
            result['qualified'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--routes', type=Path, required=True)
    parser.add_argument('--previous', type=Path, required=True)
    parser.add_argument('--landmarks', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    routes = json.loads(args.routes.read_text())
    previous = json.loads(args.previous.read_text())['routes']
    assert len(routes) == len(previous)
    for route, old in zip(routes, previous):
        assert (route['id'], route['jobId']) == (old['id'], old['jobId'])
    features = helpers['read_features'](args.landmarks)
    results = [analyze(route, old, features) for route, old in zip(routes, previous)]
    qualify(results)
    stats = {'routes': len(results),
             'changedTitles': sum(r['title'] != r['previous'] for r in results),
             'selectionRules': dict(collections.Counter(r['reason'] for r in results)),
             'qualifiedTitles': sum(r['qualified'] for r in results),
             'approachDestinationsSelected': sum(any(not x['onLoop'] and x['id'] in r['landmarks']
                                                   for x in r['eligibleDestinations']) for r in results)}
    args.output.write_text(json.dumps({'stats': stats, 'routes': results}))
    print(json.dumps(stats))


if __name__ == '__main__':
    main()
