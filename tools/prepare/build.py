"""Offline maintainer compiler; the application consumes only its gzip files."""
import argparse
import hashlib
import json
import os
import resource
import subprocess
import tempfile
import time
from pathlib import Path

from elevation import Elevation
from graph import assemble, measure, topology
from osm import extract, read_source
from tiles import write_json, write_network

HERE = Path(__file__).resolve().parent


def sha(file):
    with open(file, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_inputs(manifest, source_root):
    sources = [manifest["osm"], *manifest["elevation"]]
    paths = []
    for source in sources:
        file = source_root / source["file"]
        if not file.is_file():
            raise ValueError(f"Missing source: {file}")
        print(f"Verify {file.name}", flush=True)
        if sha(file) != source["sha256"]:
            raise ValueError(f"Source hash mismatch: {file}")
        paths.append(file)
    return paths[0], [dict(product, path=file) for product, file in zip(manifest["elevation"], paths[1:])]


def build(source, products, bounds, info):
    with tempfile.TemporaryDirectory(prefix="alpine-fresh-") as temporary:
        print("Scan source-wide ways with inline node locations; retain footprint intersections", flush=True)
        opl = extract(source, bounds, Path(temporary))
        ways, hiking, pois, node_tags, positions = read_source(opl, bounds)
        print(f"Read {len(ways):,} context ways; {len(positions):,} trail geometry nodes", flush=True)
        corridors, _, entrances, audit = topology(ways, hiking, pois, node_tags, positions, bounds)
        print(f"Compile {len(corridors):,} physical corridors; {len(entrances):,} starts", flush=True)
        samples = measure(corridors, Elevation(products).sample)
        graph, geometry, source_index = assemble(corridors, entrances, info)
        audit["counts"].update(elevationSamples=samples, nodes=len(graph["nodes"]), directedEdges=len(graph["edges"]),
                               physicalTrails=len(geometry), starts=len(entrances), frontierNodes=len(audit["frontiers"]), unresolvedPois=len(audit["unresolvedPois"]))
        return graph, geometry, source_index, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=HERE / "sources.json")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    started = time.perf_counter()
    source, products = load_inputs(manifest, args.source_root.resolve())
    info = {"id": manifest["id"], "name": manifest["name"], "bounds": manifest["bounds"],
            "sourceDate": manifest["sourceDate"], "places": manifest["places"], "startCount": 0,
            "attribution": [{"name": "OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL 1.0"},
                            {"name": "USGS 3DEP", "url": "https://www.usgs.gov/3d-elevation-program", "license": "U.S. public domain"}],
            "limitations": ["Finite source coverage: routes stop at the advertised rectangle; starts are filtered independently within it.",
                            "Includes mapped linear walking paths, tracks and cycleways; road connectors require mapped hiking/foot route membership.",
                            "Uncertain access is included and labeled. Mapped road contact is not proof of legal parking, arrival access or current conditions.",
                            "Conditional access is not evaluated for a trip date. Explicit default prohibitions remain excluded; other unresolved conditions remain uncertain.",
                            "Elevation gain is an estimate from bilinear 3DEP samples at source vertices and at most 25 m intervals; DEM noise is not suppressed.",
                            "Unconnected mapped access points are recorded in the source audit; no connections are invented across mapping gaps."]}
    graph, geometry, source_index, audit = build(source, products, manifest["bounds"], info)
    # Publish a complete directory only after every sample and output is ready.
    if args.output.exists():
        raise ValueError(f"Output already exists: {args.output}; choose a new directory")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".fresh-", dir=args.output.parent) as temporary:
        staging = Path(temporary)
        compiler = {file.name: sha(file) for file in sorted(HERE.glob("*.py"))}
        osmium = subprocess.check_output(["osmium", "--version"], text=True).splitlines()[0]
        evidence = {"manifest": {key: value for key, value in manifest.items() if key != "id"}, "osmium": osmium}
        network = write_network(staging, graph, geometry, identity_evidence=evidence)
        (staging / "audit").mkdir()
        graph = dict(graph, info=network["info"])
        files = {"manifest.json": {"bytes": (staging / "manifest.json").stat().st_size, "sha256": sha(staging / "manifest.json")}}
        for name, value in (("graph", graph), ("geometry", geometry), ("source-index", source_index), ("audit", audit)):
            filename = f"audit/{name}.json.gz"
            files[filename] = write_json(staging / filename, value, True)
        provenance = {"version": 1, "manifest": manifest, "files": files, "counts": audit["counts"],
                      "snapshotId": network["info"]["id"], "compiler": compiler, "osmium": osmium,
                      "elapsedSeconds": time.perf_counter() - started,
                      "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if os.uname().sysname == "Darwin" else 1024)}
        write_json(staging / "audit/provenance.json", provenance)
        os.rename(staging, args.output)
    print(json.dumps({"output": str(args.output), "snapshotId": network["info"]["id"], "counts": audit["counts"], "runtimeFiles": len(network["files"]),
                      "elapsedSeconds": provenance["elapsedSeconds"], "peakRssBytes": provenance["peakRssBytes"]}, indent=2), flush=True)


if __name__ == "__main__":
    main()
