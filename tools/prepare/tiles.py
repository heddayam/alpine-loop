"""Partition one compiled snapshot; cell boundaries never split its sections."""
import gzip
import hashlib
import io
import json
import math
from collections import defaultdict
from contextlib import nullcontext
from pathlib import Path


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"


def write_json(file, value, compressed=False):
    size = 0
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    with file.open("wb") as destination:
        # No filename, timestamp or platform-specific gzip header bytes.
        output = gzip.GzipFile(fileobj=destination, mode="wb", filename="", compresslevel=6, mtime=0) if compressed else nullcontext(destination)
        with output as stream, io.BufferedWriter(stream) as buffered:
            for part in encoder.iterencode(value):
                data = part.encode()
                buffered.write(data)
                size += len(data)
            buffered.write(b"\n")
    with file.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"bytes": file.stat().st_size, "jsonBytes": size + 1, "sha256": digest}


def cell(point):
    return f"{math.floor(point[0] * 10)}_{math.floor(point[1] * 10)}"


def cells(bounds):
    west, south, east, north = bounds
    for x in range(math.floor(west * 10), math.floor(east * 10) + 1):
        for y in range(math.floor(south * 10), math.floor(north * 10) + 1):
            yield f"{x}_{y}"


def write_network(directory, graph, geometry, *, identity_evidence=None):
    """Write a new immutable directory; return its version-2 runtime manifest.

    IDs are indexes into these input arrays, meaningful only in this snapshot.
    Build callers provide verified source evidence; emitted file digests and
    compiler/policy code also contribute to identity. The caller's info is copied.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError(f"Network output must be empty: {directory}")
    directions = [[] for _ in geometry]
    for index, edge in enumerate(graph["edges"]):
        directions[edge["trail"]].append([index, edge])
    graph_cells, geometry_cells, start_cells = defaultdict(list), defaultdict(list), defaultdict(list)
    for index, shape in enumerate(geometry):
        points = shape["coordinates"]
        if not points or shape["kind"] not in ("trail", "connector") or not directions[index]:
            raise ValueError(f"Section {index} lacks geometry, role or directed facts")
        bounds = [min(point[0] for point in points), min(point[1] for point in points),
                  max(point[0] for point in points), max(point[1] for point in points)]
        section = {"id": index, "bounds": bounds, "name": shape["name"], "kind": shape["kind"], "edges": directions[index]}
        for key in cells(bounds):
            graph_cells[key].append(section)
        owner = cell(((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2))
        geometry_cells[owner].append([index, shape])
    for index, start in enumerate(graph["starts"]):
        point = graph["nodes"][start["node"]]
        start_cells[cell(point)].append([index, start, point])
    files = {}
    for family, groups in (("graph", graph_cells), ("starts", start_cells), ("geometry", geometry_cells)):
        (directory / family).mkdir()
        for key, records in sorted(groups.items()):
            if family == "graph":
                endpoints = {node for section in records for _, edge in section["edges"] for node in (edge["from"], edge["to"])}
                records = {"nodes": [[node, graph["nodes"][node]] for node in sorted(endpoints)], "sections": records}
            filename = f"{family}/{key}.json.gz"
            files[filename] = write_json(directory / filename, records, True)
    info = {key: value for key, value in graph["info"].items() if key != "id"}
    compiler = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(Path(__file__).parent.glob("*.py"))}
    manifest = {"version": 2, "cellDegrees": 0.1, "distanceMetric": "haversine-6371008.8", "info": info, "files": files}
    evidence = {"network": manifest, "sources": identity_evidence, "compiler": compiler}
    info["id"] = "network-" + hashlib.sha256(json_bytes(evidence)).hexdigest()
    write_json(directory / "manifest.json", manifest)
    return manifest
