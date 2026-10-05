"""Size-gated, minimum numbered-highway cuts before graph construction."""
import heapq
import itertools
import re
import sqlite3
from collections import defaultdict

import numpy as np
from shapely import LineString, MultiPolygon, Point, get_parts, intersects, linestrings, prepare
from shapely.ops import split

from footprint import polygons
from graph import directions, distance, routable
from osm import records, way_record

MAJOR = {"motorway", "trunk", "primary"}


def ref_key(value, network=""):
    value = re.sub(r"\s", "", value.upper()).replace("SR", "WA")
    if value.isdigit():
        value = ({"US:I": "I", "US:US": "US", "US:WA": "WA"}.get(network, "") + value)
    return value if re.fullmatch(r"(?:I|US|WA)\d+", value) else None


def road_memberships(file):
    result = defaultdict(set)
    for _, fields, tags in records(file):
        ref = ref_key(tags.get("ref", ""), tags.get("network", ""))
        if ref:
            for member in fields.get("M", "").split(","):
                identity = member.split("@", 1)[0]
                if identity.startswith("w"):
                    result[identity[1:]].add(ref)
    return result


class SegmentCounts:
    """A temporary disk index keeps preflight independent of graph memory."""
    def __init__(self, file):
        self.db = sqlite3.connect(file)
        self.db.execute("PRAGMA journal_mode=OFF")
        self.db.execute("PRAGMA synchronous=OFF")
        self.db.execute("CREATE TABLE segments (id INTEGER PRIMARY KEY, ax REAL, ay REAL, bx REAL, by REAL)")
        self.db.execute("CREATE VIRTUAL TABLE bounds USING rtree(id, west, east, south, north)")
        self.pending = []
        self.cache = {}

    def add(self, a, b):
        self.pending.append((*a, *b))
        if len(self.pending) >= 4096:
            self.flush()

    def flush(self):
        first = self.db.execute("SELECT coalesce(max(id), 0) FROM segments").fetchone()[0] + 1
        self.db.executemany("INSERT INTO segments VALUES (?, ?, ?, ?, ?)",
                            ((first + i, *row) for i, row in enumerate(self.pending)))
        self.db.executemany("INSERT INTO bounds VALUES (?, ?, ?, ?, ?)",
                            ((first + i, min(ax, bx), max(ax, bx), min(ay, by), max(ay, by))
                             for i, (ax, ay, bx, by) in enumerate(self.pending)))
        self.pending.clear()

    def count(self, geometry):
        self.flush()
        key = geometry.wkb
        if key not in self.cache:
            prepare(geometry)
            w, s, e, n = geometry.bounds
            cursor = self.db.execute("SELECT ax, ay, bx, by FROM bounds JOIN segments USING(id) "
                                     "WHERE east >= ? AND west <= ? AND north >= ? AND south <= ?", (w, e, s, n))
            count = 0
            while batch := cursor.fetchmany(8192):
                coordinates = np.asarray(batch).reshape((-1, 2, 2))
                count += int(np.count_nonzero(intersects(geometry, linestrings(coordinates))))
            self.cache[key] = count
        return self.cache[key]

    def close(self):
        self.db.close()


def preflight(opl, footprint, temporary, allowed=None):
    counts = SegmentCounts(temporary / "segments.sqlite")
    membership = road_memberships(temporary / "roads.opl")
    roads = defaultdict(lambda: {"points": {}, "adjacent": defaultdict(dict)})
    w, s, e, n = footprint.bounds
    print("Preflight: stream candidate source segments into the disk index", flush=True)
    for identity, fields, tags in records(opl):
        if not identity.startswith("w"):
            continue
        way, points = way_record(identity, fields, tags)
        refs = {ref_key(value) for value in tags.get("ref", "").split(";")} | membership.get(way["id"], set())
        refs.discard(None)
        if allowed is not None:
            refs &= set(allowed)
        if tags.get("highway") in MAJOR and routable(way):
            for ref in sorted(refs):
                road = roads[ref]
                road["points"].update(zip(way["nodes"], points))
                for left, right, a, b in zip(way["nodes"], way["nodes"][1:], points, points[1:]):
                    if a != b:
                        road["adjacent"][left][right] = road["adjacent"][right][left] = distance(a, b)
        if not routable(way) or all(value is None for value in directions(tags)):
            continue
        for a, b in zip(points, points[1:]):
            if a != b and max(a[0], b[0]) >= w and min(a[0], b[0]) <= e \
                    and max(a[1], b[1]) >= s and min(a[1], b[1]) <= n:
                counts.add(a, b)
    counts.flush()
    print(f"Preflight: indexed {counts.db.execute('SELECT count(*) FROM segments').fetchone()[0]:,} bounding-box candidate segments; count exact mountain intersections", flush=True)
    return counts, roads


def shortest_path(adjacent, start, end):
    queue, labels, previous = [(0, start)], {start: 0}, {}
    while queue:
        length, node = heapq.heappop(queue)
        if node == end:
            path = [end]
            while path[-1] != start:
                path.append(previous[path[-1]])
            return list(reversed(path))
        if length != labels[node]:
            continue
        for neighbor, increment in sorted(adjacent[node].items()):
            next_length = length + increment
            if next_length < labels.get(neighbor, float("inf")):
                labels[neighbor], previous[neighbor] = next_length, node
                heapq.heappush(queue, (next_length, neighbor))
    return []


def representative(road, geometry):
    """One real, source-connected mainline; never bridge a mapping gap.

    The largest valid through trace wins. This selects one carriageway when
    opposite directions are disconnected, avoiding median sliver sections.
    """
    seen, candidates = set(), []
    for seed in sorted(road["adjacent"]):
        if seed in seen:
            continue
        pending, component = [seed], []
        while pending:
            node = pending.pop()
            if node in seen:
                continue
            seen.add(node)
            component.append(node)
            pending.extend(road["adjacent"][node])
        points = road["points"]
        axis = max((0, 1), key=lambda i: max(points[node][i] for node in component) - min(points[node][i] for node in component))
        start = min(component, key=lambda node: (points[node][axis], node))
        end = max(component, key=lambda node: (points[node][axis], node))
        path = shortest_path(road["adjacent"], start, end)
        if len(path) < 2:
            continue
        line = LineString([points[node] for node in path])
        if not line.is_simple or not line.intersects(geometry):
            continue
        through = any(len(polygons(split(poly, line))) > 1 for poly in polygons(geometry))
        candidates.append((through, line.length, tuple(path), line))
    return max(candidates, key=lambda item: item[:3])[3] if candidates else None


def split_section(geometry, line):
    """Keep disconnected GMBA patches in two logical sides of the corridor."""
    pieces = [part for poly in polygons(geometry) for part in polygons(split(poly, line))]
    if len(pieces) == len(polygons(geometry)):
        return None
    sides = [[], []]
    for piece in pieces:
        shared = [part for part in get_parts(piece.boundary.intersection(line)) if isinstance(part, LineString) and part.length > 0]
        point = max(shared, key=lambda part: part.length).interpolate(.5, normalized=True) if shared else piece.representative_point()
        location = line.project(point)
        a, b = line.interpolate(max(0, location - 1e-6)), line.interpolate(min(line.length, location + 1e-6))
        dx, dy = b.x - a.x, b.y - a.y
        if shared:
            # Use which side borders this actual road segment, rather than a
            # distant representative point that can misclassify winding cuts.
            scale = 1e-8 / max(abs(dx), abs(dy))
            left = Point(point.x - dy * scale, point.y + dx * scale)
            right = Point(point.x + dy * scale, point.y - dx * scale)
            if piece.contains(left) or piece.contains(right):
                sides[0 if piece.contains(left) else 1].append(piece)
                continue
            point = piece.representative_point()
        cross = dx * (point.y - a.y) - dy * (point.x - a.x)
        sides[0 if cross >= 0 else 1].append(piece)
    grouped = [MultiPolygon(side) for side in sides]
    return grouped if all(side.is_valid and not side.is_empty for side in grouped) else None


def choose_sections(geometry, roads, count, cap):
    """Keep small regions whole; prefer freeways, minimize other valid cuts."""
    if count(geometry) <= cap:
        return [(geometry, [])], []
    candidates = {ref: line for ref, road in sorted(roads.items()) if (line := representative(road, geometry)) is not None}
    freeways = [ref for ref in candidates if ref.startswith("I")]
    lower = [ref for ref in candidates if ref not in freeways]
    if len(lower) > 12:
        raise ValueError("More than 12 lower-tier through corridors: narrow candidateRefs before exact minimum-cut planning")

    def apply(refs):
        sections, used = [(geometry, [])], []
        changed = True
        while changed:
            changed = False
            for ref in refs:
                next_sections = []
                line = candidates[ref]
                for area, labels in sections:
                    parts = split_section(area, line) if ref not in dict(labels) and count(area) > cap else None
                    if parts:
                        changed = True
                        if ref not in used:
                            used.append(ref)
                        axis = 0 if abs(line.coords[-1][0] - line.coords[0][0]) >= abs(line.coords[-1][1] - line.coords[0][1]) else 1
                        names = ("north", "south") if axis == 0 else ("west", "east")
                        next_sections.extend((part, labels + [(ref, names[i])]) for i, part in enumerate(parts))
                    else:
                        next_sections.append((area, labels))
                sections = next_sections
        return sections, used

    best, best_score = None, None
    for size in range(len(lower) + 1):
        for subset in itertools.combinations(lower, size):
            sections, used = apply([*freeways, *subset])
            excess = sum(max(0, count(area) - cap) for area, _ in sections)
            score = (excess, len([ref for ref in used if ref in lower]), tuple(used))
            if best_score is None or score < best_score:
                best, best_score = (sections, used), score
        if best_score[0] == 0:
            break
    sections, used = best
    return sections, [{"ref": ref, "tier": 0 if ref in freeways else 1,
                       "geometry": {"type": "LineString", "coordinates": list(candidates[ref].coords)}} for ref in used]
