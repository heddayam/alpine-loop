"""Compile one finite source footprint without a hike-distance admission rule."""
import hashlib
import math
from collections import defaultdict

from footprint import as_footprint

PATHS = {"path", "footway", "bridleway", "steps", "pedestrian", "cycleway"}
# Tracks are land-access roads; pedestrian permission does not change their role.
ROADS = {"track", "service", "residential", "living_street", "unclassified", "road", "tertiary", "secondary",
         "primary", "trunk", "motorway", "tertiary_link", "secondary_link", "primary_link", "trunk_link", "motorway_link"}
DENIED = {"no", "private", "closed", "agricultural", "forestry", "customers", "destination", "delivery"}
PUBLIC = {"yes", "designated", "permissive", "public"}
VEHICLE_MODES = ("motorcar", "motor_vehicle", "vehicle", "access")


def permission(tags, direction=None, modes=("foot", "access")):
    keys = [key for mode in modes
            for key in ([f"{mode}:{direction}", mode] if direction else [mode])]
    found = next((index for index, key in enumerate(keys) if key in tags), len(keys))
    value = tags.get(keys[found]) if found < len(keys) else None
    if value in DENIED:
        return None
    conditional = any(f"{key}:conditional" in tags for key in keys[:found + 1])
    return "public" if value in PUBLIC and not conditional else "unknown"


def directions(tags):
    result = [permission(tags, side) for side in ("forward", "backward")]
    # Product routing policy: motor-only roads need pedestrian-specific evidence,
    # even when generic access is public. More-specific foot tags still win.
    if tags.get("highway") in ("motorway", "motorway_link") or tags.get("motorroad") == "yes":
        for index, side in enumerate(("forward", "backward")):
            if tags.get(f"foot:{side}", tags.get("foot")) not in PUBLIC:
                result[index] = None
    oneway = tags.get("oneway:foot")
    if oneway == "-1":
        result[0] = None
    if oneway in ("yes", "1"):
        result[1] = None
    for index in range(2):
        ambiguous = "oneway:foot:conditional" in tags or oneway in ("reversible", "alternating")
        if tags.get("highway") in PATHS and oneway is None:
            ambiguous |= "oneway:conditional" in tags or tags.get("oneway") in ("reversible", "alternating")
            ambiguous |= tags.get("oneway") in (("-1",) if index == 0 else ("yes", "1"))
        if ambiguous and result[index] == "public":
            result[index] = "unknown"
    return result


def crossing(tags):
    # A parking POI's access restriction concerns that place, not an invented
    # prohibition on every path that happens to share its node.
    object_only = tags.get("amenity") == "parking" or tags.get("tourism") == "information"
    if object_only and not tags.get("barrier"):
        return "public"
    if not any(key == "foot" or key.startswith("foot:") or key == "access" or key.startswith("access:")
               for key in tags) and not tags.get("barrier"):
        return "public"
    state = permission(tags)
    if tags.get("barrier") in ("wall", "fence", "retaining_wall") and state != "public":
        return None
    return state


def combine(*states):
    return None if None in states else "unknown" if "unknown" in states else "public"


def routable(way):
    tags = way["tags"]
    highway = tags.get("highway")
    non_current = any(tags.get(key) in ("yes", "1", "true") for key in ("disused", "abandoned", "construction", "proposed"))
    return not non_current and tags.get("area") != "yes" and (highway in PATHS or highway in ROADS)


def role(tags):
    # Candidate classification only, not proof that a mapped path is a hike.
    return "connector" if tags.get("highway") in ROADS or tags.get("footway") in ("sidewalk", "crossing") else "trail"


def distance(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a[:2], *b[:2]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742017.6 * math.asin(min(1, math.sqrt(h)))


def topology(ways, pois, tags_by_node, positions, footprint):
    footprint = as_footprint(footprint)
    segments, points, frontiers = {}, {}, set()
    counts = {"selectedWays": 0, "outsideSegments": 0, "prohibitedSegments": 0, "duplicateSegments": 0, "zeroLengthSegments": 0}
    for way in sorted(ways.values(), key=lambda item: item["id"]):
        if not routable(way):
            continue
        counts["selectedWays"] += 1
        access = directions(way["tags"])
        kind = role(way["tags"])
        for ordinal, (left, right) in enumerate(zip(way["nodes"], way["nodes"][1:])):
            physical = tuple(sorted((left, right)))
            a, b = (positions[node] for node in physical)
            source_reversed = physical[0] != left
            intervals = footprint.intervals(a, b)
            if not intervals:
                counts["outsideSegments"] += 1
                continue
            for canonical_interval in intervals:
                endpoints = []
                for fraction in canonical_interval:
                    original = fraction in (0, 1)
                    key = "n" + physical[int(fraction)] if original else f"frontier:n{physical[0]}:n{physical[1]}:{fraction.hex()}"
                    point = (a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction)
                    points[key] = point
                    if not original:
                        frontiers.add(key)
                    endpoints.append(key)
                interval = (1 - canonical_interval[1], 1 - canonical_interval[0]) if source_reversed else canonical_interval
                if source_reversed:
                    endpoints.reverse()
                if distance(points[endpoints[0]], points[endpoints[1]]) < 1e-7:
                    counts["zeroLengthSegments"] += 1
                    continue
                node_access = combine(crossing(tags_by_node.get(left, {})) if interval[0] == 0 else "public",
                                      crossing(tags_by_node.get(right, {})) if interval[1] == 1 else "public")
                states = [combine(value, node_access) for value in access]
                key = tuple(sorted(endpoints))
                if endpoints[0] != key[0]:
                    states.reverse()
                lineage = {"way": way["id"], "segment": ordinal, "nodes": [left, right], "fraction": list(interval), "kind": kind,
                           "reversed": endpoints[0] != key[0]}
                if key in segments:
                    counts["duplicateSegments"] += 1
                    existing = segments[key]
                    existing["access"] = [combine(a, b) for a, b in zip(existing["access"], states)]
                    existing["source"].append(lineage)
                    existing["names"].update(filter(None, [way["tags"].get("name")]))
                    if kind == "connector":
                        existing["kind"] = kind
                else:
                    segments[key] = {"ends": key, "access": states, "source": [lineage],
                                     "kind": kind, "names": set(filter(None, [way["tags"].get("name")]))}
    usable = []
    adjacent = defaultdict(list)
    for segment in segments.values():
        if all(value is None for value in segment["access"]):
            counts["prohibitedSegments"] += 1
            continue
        index = len(usable)
        usable.append(segment)
        for node in segment["ends"]:
            adjacent[node].append(index)

    # Road contact is a starting possibility, never proof of legal parking.
    entrances = {}
    # Use resolved physical roles: an explicit sidewalk wins over a duplicate
    # generic path, and a prohibited segment cannot establish a trail contact.
    trail_nodes = {node for segment in usable if segment["kind"] == "trail" for node in segment["ends"]}
    for way in ways.values():
        if way["tags"].get("highway") not in ROADS or not routable(way):
            continue
        # Walking a closed road is different from arriving by car. Foot tags
        # cannot restore vehicle access; more-specific vehicle tags can.
        if all(permission(way["tags"], side, VEHICLE_MODES) is None
               for side in ("forward", "backward")):
            continue
        for node in way["nodes"]:
            key = "n" + node
            if key in trail_nodes and key not in frontiers and crossing(tags_by_node.get(node, {})) is not None:
                entrances.setdefault(key, {"id": "osm-entrance:" + node, "name": "Trail entrance", "access": "unknown", "sources": []})
                entrances[key]["sources"].append("w" + way["id"])
    unresolved = []
    for poi in pois:
        walking = permission(poi["tags"])
        arrival = permission(poi["tags"], modes=VEHICLE_MODES) if poi["kind"] == "parking" else "public"
        access = combine(walking, arrival)
        connections = ["n" + node for node in poi["nodes"] if "n" + node in adjacent and "n" + node not in frontiers]
        if access is None or not connections:
            unresolved.append({"id": poi["id"], "kind": poi["kind"], "name": poi["tags"].get("name"),
                               "reason": "restricted vehicle access" if arrival is None else "restricted walking access" if walking is None
                               else "no shared routable OSM node", "nodes": poi["nodes"]})
            continue
        for node in connections:
            entry = entrances.setdefault(node, {"id": "osm-entrance:" + node[1:], "sources": []})
            rank = 2 if poi["kind"] == "trailhead" else 1
            if rank > entry.get("rank", 0):
                entry.update(name=poi["tags"].get("name") or ("Trailhead" if poi["kind"] == "trailhead" else "Mapped parking access"), rank=rank)
            # Name priority is unrelated to permission evidence. An untagged
            # trailhead cannot erase public permission from its mapped parking.
            evidence = "public" if "public" in (entry.get("access"), access) else "unknown"
            entry["access"] = combine(evidence, crossing(tags_by_node.get(node[1:], {})))
            entry["sources"].append(poi["id"])
    anchors = set(entrances) | (frontiers & adjacent.keys())
    anchors.update(node for node, edges in adjacent.items() if len(edges) != 2 or tags_by_node.get(node[1:], {}).get("barrier"))
    def oriented(index, start):
        segment = usable[index]
        return segment["access"] if segment["ends"][0] == start else list(reversed(segment["access"]))
    for node, edges in adjacent.items():
        if len(edges) == 2 and (oriented(edges[0], node) != list(reversed(oriented(edges[1], node)))
                               or usable[edges[0]]["kind"] != usable[edges[1]]["kind"]):
            anchors.add(node)
    corridors, visited = [], set()
    # Components consisting solely of a ring still require an anchor.
    pending = sorted(anchors)
    while len(visited) < len(usable):
        if not pending:
            pending.append(next(segment["ends"][0] for index, segment in enumerate(usable) if index not in visited))
            anchors.add(pending[0])
        start = pending.pop()
        for first in adjacent[start]:
            if first in visited:
                continue
            path_nodes, members, names = [start], [], set()
            node, index = start, first
            state = oriented(index, node)
            kind = usable[index]["kind"]
            while True:
                visited.add(index)
                segment = usable[index]
                reverse = segment["ends"][0] != node
                members.append({"source": segment["source"], "reverse": reverse})
                names.update(segment["names"])
                node = segment["ends"][0] if reverse else segment["ends"][1]
                path_nodes.append(node)
                if node in anchors:
                    break
                index = next(edge for edge in adjacent[node] if edge not in visited)
            identity = hashlib.sha256("|".join(path_nodes).encode()).hexdigest()[:24]
            corridors.append({"id": "osm-corridor:" + identity, "nodes": path_nodes, "coordinates": [points[node] for node in path_nodes],
                              "access": state, "kind": kind, "name": " / ".join(sorted(names)) or None, "source": members})
    return corridors, points, entrances, {"counts": counts, "frontiers": sorted(frontiers & adjacent.keys()),
                                         "unresolvedPois": unresolved, "entrances": entrances}


def measure(corridors, sample):
    profiles, unique = [], {}
    for corridor in corridors:
        dense = [corridor["coordinates"][0]]
        for a, b in zip(corridor["coordinates"], corridor["coordinates"][1:]):
            steps = max(1, math.ceil(distance(a, b) / 25))
            dense.extend((a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps) for step in range(1, steps))
            dense.append(b)
        profiles.append(dense)
        for point in dense:
            unique.setdefault(point, len(unique))
    elevations = sample(list(unique))
    if len(elevations) != len(unique) or any(value is None or not math.isfinite(value) for value in elevations):
        raise ValueError("Every retained geometry sample must have a finite measured elevation")
    for corridor, profile in zip(corridors, profiles):
        heights = [elevations[unique[point]] for point in profile]
        corridor["distance"] = sum(distance(a, b) for a, b in zip(profile, profile[1:]))
        corridor["gains"] = [sum(max(0, sign * (b - a)) for a, b in zip(heights, heights[1:])) for sign in (1, -1)]
        corridor["geometry"] = [[*point, height] for point, height in zip(profile, heights)]
    return len(unique)


def assemble(corridors, entrances, info):
    node_ids = sorted({node for corridor in corridors for node in (corridor["nodes"][0], corridor["nodes"][-1])})
    indexes = {node: index for index, node in enumerate(node_ids)}
    nodes, edges, geometry, edge_ids = [None] * len(node_ids), [], [], []
    for trail, corridor in enumerate(corridors):
        for node, point in ((corridor["nodes"][0], corridor["geometry"][0]), (corridor["nodes"][-1], corridor["geometry"][-1])):
            nodes[indexes[node]] = point
        geometry.append({"id": corridor["id"], "name": corridor["name"], "kind": corridor["kind"], "coordinates": corridor["geometry"]})
        for direction, access in enumerate(corridor["access"]):
            if access is None:
                continue
            ends = [indexes[corridor["nodes"][0]], indexes[corridor["nodes"][-1]]]
            if direction:
                ends.reverse()
            edges.append({"from": ends[0], "to": ends[1], "trail": trail, "reverse": bool(direction),
                          "distance": corridor["distance"], "gain": corridor["gains"][direction], "access": access,
                          "connector": corridor["kind"] == "connector"})
            edge_ids.append(corridor["id"] + (":reverse" if direction else ":forward"))
    starts = [{"id": entrances[node]["id"], "node": indexes[node], "name": entrances[node]["name"], "access": entrances[node]["access"],
               "kind": {2: "trailhead", 1: "parking"}.get(entrances[node].get("rank", 0), "road-contact")}
              for node in sorted(entrances)]
    info = dict(info, startCount=len(starts))
    return {"version": 1, "info": info, "nodes": nodes, "edges": edges, "starts": starts}, geometry, {
        "nodeIds": node_ids, "edgeIds": edge_ids,
        "trails": [{"id": corridor["id"], "kind": corridor["kind"], "nodes": corridor["nodes"], "segments": corridor["source"]} for corridor in corridors]}
