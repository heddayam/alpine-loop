"""Replay a fixed raw-source witness; no route search or solver imports."""
import argparse
import gzip
import hashlib
import json
import math
import re
import subprocess
from collections import defaultdict
from pathlib import Path


def read(directory, name):
    with gzip.open(directory / f"{name}.json.gz") as stream:
        return json.load(stream)


def distance(a, b):
    x, y, xx, yy = map(math.radians, (*a[:2], *b[:2]))
    h = math.sin((yy - y) / 2) ** 2 + math.cos(y) * math.cos(yy) * math.sin((xx - x) / 2) ** 2
    return 12742017.6 * math.asin(min(1, math.sqrt(h)))


def raw_objects(file, ids):
    output = subprocess.check_output(["osmium", "getid", str(file), *ids, "-r", "-f", "opl"], text=True)
    decode = lambda value: re.sub(r"%([0-9a-fA-F]+)%", lambda m: chr(int(m[1], 16)), value)
    result = {}
    for line in output.splitlines():
        identity, *fields = line.split(" ")
        fields = {field[0]: field[1:] for field in fields if field}
        tags = dict(tuple(map(decode, pair.split("=", 1))) for pair in fields.get("T", "").split(",") if pair)
        result[identity] = ({"tags": tags, "nodes": fields["N"].split(",")} if identity[0] == "w"
                            else {"tags": tags, "position": [float(fields["x"]), float(fields["y"])]})
    return result


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("dataset", type=Path)
parser.add_argument("--raw-source", type=Path, help="Defaults to the pinned source under the repository's .cache directory.")
args = parser.parse_args()
evidence = json.loads(Path(__file__).with_name("witness.json").read_text())
source = args.raw_source or Path(__file__).resolve().parents[2] / ".cache" / evidence["sourceSnapshot"]["file"]
with source.open("rb") as stream:
    assert hashlib.file_digest(stream, "sha256").hexdigest() == evidence["sourceSnapshot"]["sha256"], "Raw source changed"
raw_ids = [key for key in evidence["rawObjects"] if key.startswith("w")] + ["n4729927256", "n12761651948"]
raw = raw_objects(source, raw_ids)
assert raw == evidence["rawObjects"], "Captured source evidence differs from the pinned raw snapshot"

graph, index, geometry = [read(args.dataset, name) for name in ("graph", "source-index", "geometry")]
starts = {start["id"]: start for start in graph["starts"]}
variant = "baseline" if evidence["baseline"]["startId"] in starts else "namedTrailheadAlternative"
fixed = evidence[variant]
start = starts[fixed["startId"]]
walk = fixed["orderedSourceNodes"]
assert index["nodeIds"][start["node"]] == walk[0] == walk[-1]
assert start["access"] == "public", "The public-only frozen query must admit the chosen start"

# Check every prescribed physical segment against the actual raw way node order.
raw_pairs = set()
for way in {entry["way"] for entry in evidence["baseline"]["orderedSourceSegments"]}:
    value = raw["w" + way]
    assert value["tags"].get("foot") == "designated"
    assert not any(key.startswith("foot:") or key.startswith("oneway:foot") for key in value["tags"])
    for a, b in zip(value["nodes"], value["nodes"][1:]):
        raw_pairs.update(((a, b), (b, a)))
raw_distance = raw_repeat = 0
used_pairs = set()
for a, b in zip(walk, walk[1:]):
    assert (a, b) in raw_pairs, f"Missing raw trail connection: {a} -> {b}"
    length = distance(raw[a]["position"], raw[b]["position"])
    pair = tuple(sorted((a, b)))
    raw_distance += length
    if pair in used_pairs:
        raw_repeat += length
    used_pairs.add(pair)
for node in set(walk):
    tags = raw[node]["tags"]
    assert tags.get("foot", tags.get("access")) not in {"no", "private", "closed", "destination", "customers"}

# Independently check that the fixed walk is a simple cycle with one reversed stem.
stem = 0
while stem + 1 < len(walk) // 2 and walk[stem + 1] == walk[-stem - 2]:
    stem += 1
cycle = walk[stem:len(walk) - stem]
assert cycle[0] == cycle[-1] and len(set(cycle[:-1])) == len(cycle) - 1
assert len(set(walk[:stem + 1])) == stem + 1
assert set(walk[:stem]).isdisjoint(cycle)

# Match only successive prefixes of that fixed source walk. This accommodates
# changed degree-two corridor anchors; it cannot discover or substitute a route.
by_first = defaultdict(list)
for number, edge in enumerate(graph["edges"]):
    nodes = index["trails"][edge["trail"]]["nodes"]
    chain = nodes[::-1] if edge["reverse"] else nodes
    by_first[chain[0]].append((number, edge, chain))
at = 0
total = gain = repeat = 0
used_trails, sequence = set(), []
while at < len(walk) - 1:
    choices = [item for item in by_first[walk[at]] if item[2] == walk[at:at + len(item[2])]]
    assert len(choices) == 1, f"Missing or ambiguous compiled corridor at raw node {walk[at]}"
    number, edge, chain = choices[0]
    assert edge["access"] == "public"
    points = geometry[edge["trail"]]["coordinates"]
    if edge["reverse"]:
        points = points[::-1]
    profile_gain = sum(max(0, b[2] - a[2]) for a, b in zip(points, points[1:]))
    assert abs(profile_gain - edge["gain"]) < 0.001, "DEM profile and edge gain disagree"
    cursor = 0
    for node in chain:
        point = raw[node]["position"]
        while cursor < len(points) and any(abs(points[cursor][axis] - point[axis]) > 1e-10 for axis in (0, 1)):
            cursor += 1
        assert cursor < len(points), f"Original source geometry omitted: {node}"
    total += edge["distance"]
    gain += edge["gain"]
    if edge["trail"] in used_trails:
        repeat += edge["distance"]
    used_trails.add(edge["trail"])
    sequence.append(index["edgeIds"][number])
    at += len(chain) - 1
assert abs(total - raw_distance) < 0.05
assert abs(repeat - raw_repeat) < 0.05
query = evidence["query"]
lon, lat = graph["nodes"][start["node"]][:2]
assert query["area"][0] <= lon <= query["area"][2] and query["area"][1] <= lat <= query["area"][3]
assert query["distance"][0] <= total <= query["distance"][1]
assert query["gain"][0] <= gain <= query["gain"][1]
assert repeat / total <= query["repetition"]
print(json.dumps({"datasetId": graph["info"]["id"],
                  "graphSha256": hashlib.sha256((args.dataset / "graph.json.gz").read_bytes()).hexdigest(),
                  "variant": variant, "startId": start["id"],
                  "sourceSnapshotVerified": True, "rawWalkSegments": len(walk) - 1,
                  "querySatisfied": True, "kind": "lollipop", "uncertain": False,
                  "metrics": {"distance": total, "gain": gain, "repetition": repeat / total,
                              "miles": total / 1609.344, "gainFeet": gain / 0.3048},
                  "orderedEdges": sequence}, indent=2))
