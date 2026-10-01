"""Small source reader. OSM identities, not coordinate proximity, join paths."""
import re
import subprocess

from graph import clip, routable


def decode(value):
    def replace(match):
        encoded = match.group(1)
        if not encoded or not re.fullmatch(r"[0-9a-fA-F]{1,6}", encoded):
            raise ValueError(f"Invalid OPL escape: {match.group(0)}")
        point = int(encoded, 16)
        if point > 0x10FFFF or 0xD800 <= point <= 0xDFFF:
            raise ValueError("Invalid OPL Unicode point")
        return chr(point)
    return re.sub(r"%([^%]*)%|%", replace, value)


def records(file):
    with open(file, encoding="utf8") as lines:
        for line in lines:
            fields = line.rstrip("\n").split(" ")
            attributes = {field[0]: field[1:] for field in fields[1:] if field}
            tags = {}
            for item in filter(None, attributes.get("T", "").split(",")):
                key, value = item.split("=", 1)
                tags[decode(key)] = decode(value)
            yield fields[0], attributes, tags


def poi_kind(tags):
    if tags.get("highway") == "trailhead" or tags.get("information") == "trailhead":
        return "trailhead"
    if tags.get("amenity") == "parking":
        return "parking"
    return None


def extract(source, bounds, temporary):
    filtered, opl = [temporary / name for name in ("paths.pbf", "paths.opl")]
    # A node-in-box extract loses sparse segments crossing the box with both
    # endpoints outside. Native Osmium scans source-wide; Python retains only
    # intersecting ways and their context, never a statewide routing graph.
    subprocess.run(["osmium", "tags-filter", str(source), "w/highway", "nwr/amenity=parking",
                    "nw/highway=trailhead", "nw/information=trailhead", "n/barrier", "n/foot", "n/access",
                    "-o", str(filtered)], check=True)
    subprocess.run(["osmium", "add-locations-to-ways", str(filtered), "-f", "opl", "-o", str(opl)], check=True)
    return opl


def read_source(opl, bounds):
    ways, relations, pois, tagged_nodes, positions = {}, {}, [], {}, {}
    w, s, e, n = bounds
    for identity, fields, tags in records(opl):
        if identity.startswith("w"):
            refs, points = [], []
            for reference in filter(None, fields.get("N", "").split(",")):
                match = re.fullmatch(r"n(-?\d+)x([^y]+)y(.+)", reference)
                if not match:
                    raise ValueError(f"Missing inline node location: {reference}")
                refs.append(match[1])
                points.append((float(match[2]), float(match[3])))
            if not any(clip(a, b, bounds) is not None for a, b in zip(points, points[1:])):
                continue
            ways[identity[1:]] = {"id": identity[1:], "nodes": refs, "tags": tags}
            positions.update(zip(refs, points))
            if poi_kind(tags):
                pois.append({"id": identity, "nodes": refs, "tags": tags, "kind": poi_kind(tags)})
        elif identity.startswith("r"):
            members = [part.split("@", 1)[0] for part in fields.get("M", "").split(",") if part]
            relations[identity[1:]] = {"members": members, "tags": tags}
        elif tags and w <= float(fields["x"]) <= e and s <= float(fields["y"]) <= n:
            tagged_nodes[identity[1:]] = tags
            if poi_kind(tags):
                pois.append({"id": identity, "nodes": [identity[1:]], "tags": tags, "kind": poi_kind(tags)})
    def members(relation_id, seen=None):
        if seen is None:
            seen = set()
        if relation_id in seen:
            return []
        seen.add(relation_id)
        result = []
        for member in relations.get(relation_id, {}).get("members", []):
            if member.startswith("w"):
                result.append(member[1:])
            elif member.startswith("r"):
                result.extend(members(member[1:], seen))
        return result
    for identity, relation in relations.items():
        if poi_kind(relation["tags"]):
            refs = [node for way in members(identity) for node in ways.get(way, {}).get("nodes", [])]
            if refs:
                pois.append({"id": "r" + identity, "nodes": refs, "tags": relation["tags"], "kind": poi_kind(relation["tags"])})
    needed = {node for way in ways.values() if routable(way) for node in way["nodes"]}
    return ways, pois, tagged_nodes, {node: positions[node] for node in needed}
