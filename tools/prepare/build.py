"""Maintainer plan/build CLI. Hikers download only complete prepared sections."""
import argparse
import hashlib
import json
import os
import resource
import subprocess
import platform
import tempfile
import time
import urllib.request
from urllib.parse import urlparse
from pathlib import Path

from shapely import box
from shapely.geometry import shape
import numpy
import rasterio
import shapely
import shapefile

from elevation import Elevation
from footprint import Footprint, boundary, inventory, multipolygon
from graph import assemble, measure, topology
from osm import extract, read_source
from output import json_bytes, write_json, write_section
from partition import choose_sections, preflight

HERE = Path(__file__).resolve().parent


def sha(file):
    with open(file, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def acquire(source, root):
    file = root / source["file"]
    if not file.is_file():
        if not source.get("url", "").startswith("https://"):
            raise ValueError(f"Missing source with no HTTPS URL: {file}")
        file.parent.mkdir(parents=True, exist_ok=True)
        print(f"Download {file.name}", flush=True)
        with tempfile.NamedTemporaryFile(prefix=".download-", dir=file.parent, delete=False) as temporary:
            pending = Path(temporary.name)
            try:
                with urllib.request.urlopen(source["url"], timeout=120) as response:
                    while chunk := response.read(1024 * 1024):
                        temporary.write(chunk)
                temporary.flush()
                if sha(pending) != source["sha256"]:
                    raise ValueError(f"Downloaded source hash mismatch: {file.name}")
                os.replace(pending, file)
            finally:
                pending.unlink(missing_ok=True)
    print(f"Verify {file.name}", flush=True)
    if sha(file) != source["sha256"]:
        raise ValueError(f"Source hash mismatch: {file}")
    return file


def compiler_identity():
    return {file.name: sha(file) for file in sorted([*HERE.glob("*.py"), HERE / "pyproject.toml"])}


def evidence(manifest):
    return {"manifest": manifest, "compiler": compiler_identity(),
            "environment": {"python": platform.python_version(), "numpy": numpy.__version__, "rasterio": rasterio.__version__,
                            "gdal": rasterio.__gdal_version__, "shapely": shapely.__version__, "geos": shapely.geos_version_string,
                            "pyshp": shapefile.__version__},
            "osmium": subprocess.check_output(["osmium", "--version"], text=True).splitlines()[0]}


def dataset_info(manifest, geometry):
    info = {"id": "pending", "name": manifest["name"], "bounds": list(geometry.bounds),
            "sourceDate": manifest["sourceDate"], "startCount": 0,
            "attribution": [{"name": "OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL 1.0"},
                            {"name": "GMBA Mountain Inventory v2.0", "url": "https://www.earthenv.org/mountains", "license": "CC BY 4.0"},
                            {"name": "U.S. Census Bureau state boundaries", "url": "https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html", "license": "U.S. public domain"},
                            {"name": "USGS 3DEP", "url": "https://www.usgs.gov/3d-elevation-program", "license": "U.S. public domain"}],
            "limitations": ["Mountain coverage follows the exact GMBA standard inventory clipped to the supported state outline.",
                            "Selected major highways are hard hiking boundaries, including pedestrian bridges and underpasses.",
                            "Includes mapped walking paths and road connectors; unknown access remains included and labeled. Explicit prohibitions are respected.",
                            "Mapped road contact is not proof of legal parking or current conditions. Conditional access is not evaluated for a trip date.",
                            "Elevation gain is estimated from bilinear 3DEP samples at source vertices and at most 25 m intervals; DEM noise is not suppressed.",
                            "No connections are invented across mapping gaps. Each prepared section is a complete search region."]}
    if manifest.get("elevationSupplement"):
        info["attribution"].append({"name": "Copernicus DEM GLO-30", "url": "https://registry.opendata.aws/copernicus-dem/",
                                    "license": "Copernicus DEM licence; © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018"})
        info["limitations"].append("Small elevation gaps near the Canadian border use pinned Copernicus 30 m surface heights. Resolution, vegetation and vertical-datum differences can affect estimated climb.")
    return info


def make_plan(manifest, root, temporary, max_segments):
    proof = evidence(manifest)
    gmba, _ = inventory(acquire(manifest["gmba"], root), "GMBA_V2_ID", manifest["regionId"])
    coverage, _ = inventory(acquire(manifest["coverage"], root), "STUSPS", manifest["state"])
    geometry = multipolygon(gmba.intersection(coverage))
    footprint = Footprint(geometry)
    opl = extract(acquire(manifest["osm"], root), temporary)
    counts, roads = preflight(opl, footprint, temporary, manifest.get("candidateRefs"))
    try:
        print("Plan: evaluate genuine through corridors and minimum required cuts", flush=True)
        areas, cuts = choose_sections(geometry, roads, counts.count, max_segments)
        sections = []
        for area, labels in areas:
            source_segments = counts.count(area)
            decisions = [{"ref": ref, "side": side} for ref, side in labels]
            identity = {"sources": proof, "regionId": manifest["regionId"], "boundary": boundary(area),
                        "cuts": decisions, "maxSegments": max_segments}
            section_id = "mountain-" + hashlib.sha256(json_bytes(identity)).hexdigest()[:24]
            name = manifest["name"] + (" — " + ", ".join(f"{side} of {ref}" for ref, side in labels) if labels else "")
            sections.append({"id": section_id, "regionId": manifest["regionId"], "name": name,
                             "bounds": list(area.bounds), "boundary": boundary(area), "sourceSegments": source_segments,
                             "cuts": decisions, "status": "ready" if source_segments <= max_segments else "unresolved",
                             **({"reason": f"{source_segments:,} source segments exceeds the {max_segments:,} limit; no approved through highway can resolve it."}
                                if source_segments > max_segments else {})})
        if evidence(manifest) != proof:
            raise ValueError("Compiler or source manifest changed while planning; rerun the plan")
        return {"version": 1, "evidence": proof, "info": dataset_info(manifest, geometry),
                "policy": {"maxSegments": max_segments, "thresholdStatus": "provisional; calibrate against preparation and loaded graph memory"},
                "sourceSegments": counts.count(geometry), "cuts": cuts,
                "sections": sorted(sections, key=lambda section: (section["bounds"][1], section["id"]))}
    finally:
        counts.close()


def compile_section(opl, products, footprint, info, supplement=()):
    ways, pois, tags, positions = read_source(opl, footprint)
    print(f"Retained {len(ways):,} context ways; {len(positions):,} source nodes", flush=True)
    corridors, points, entrances, audit = topology(ways, pois, tags, positions, footprint)
    del ways, pois, tags, positions, points
    print(f"Compile {len(corridors):,} corridors; {len(entrances):,} starts", flush=True)
    elevation = Elevation(products, supplement)
    samples = measure(corridors, elevation.sample)
    graph, geometry, source_index = assemble(corridors, entrances, info)
    audit["counts"].update(elevationSamples=samples, nodes=len(graph["nodes"]), directedEdges=len(graph["edges"]),
                           physicalTrails=len(geometry), starts=len(entrances), frontierNodes=len(audit["frontiers"]),
                           elevationSupplementSamples=elevation.supplement_samples)
    return graph, geometry, source_index, audit


def build(source, products, footprint, info):
    """Actual native source → topology → measured DEM path for offline tests."""
    with tempfile.TemporaryDirectory(prefix="alpine-prepare-") as temporary:
        return compile_section(extract(source, Path(temporary)), products, footprint, info)


def build_catalog(manifest, plan, root, output, selected, audit_enabled, base_url=None):
    proof = evidence(manifest)
    if plan["evidence"] != proof:
        raise ValueError("Plan sources/compiler differ from this build; run plan again")
    requested = set(selected or [section["id"] for section in plan["sections"] if section["status"] == "ready"])
    known = {section["id"] for section in plan["sections"]}
    if not requested or requested - known:
        raise ValueError("Choose at least one known, buildable section from the plan")
    for section in plan["sections"]:
        if section["id"] in requested and section["status"] != "ready":
            raise ValueError(section["reason"])
    if output.exists():
        raise ValueError(f"Output already exists: {output}; choose a new directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    source = acquire(manifest["osm"], root)
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix=".mountains-", dir=output.parent) as directory, tempfile.TemporaryDirectory(prefix="alpine-source-") as temporary:
        staging = Path(directory)
        opl = extract(source, Path(temporary))
        catalog = {"version": 1, "info": dict(plan["info"]), "sections": [], "unavailable": []}
        if base_url:
            url = urlparse(base_url)
            if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or url.query or url.fragment or not url.path.endswith("/"):
                raise ValueError("Download base URL must be an absolute HTTP(S) URL ending in a slash")
            catalog["baseUrl"] = base_url
        observations = []
        cut_lines = [shape(cut["geometry"]) for cut in plan["cuts"]]
        for section in plan["sections"]:
            if section["id"] not in requested:
                catalog["unavailable"].append({key: section[key] for key in ("name", "bounds", "boundary")} | {
                    "reason": section.get("reason", "This mountain section has not been prepared yet.")})
                continue
            geometry = shape(section["boundary"])
            products = [dict(product, path=acquire(product, root)) for product in manifest["elevation"]
                        if geometry.intersects(box(*product["bounds"]))]
            supplement = [dict(product, path=acquire(product, root)) for product in manifest.get("elevationSupplement", [])
                          if geometry.intersects(box(*product["bounds"]))]
            relevant = {decision["ref"] for decision in section["cuts"]}
            dividers = [line for cut, line in zip(plan["cuts"], cut_lines) if cut["ref"] in relevant]
            print(f"Prepare {section['name']} ({section['sourceSegments']:,} source segments)", flush=True)
            section_started = time.perf_counter()
            info = dict(plan["info"], id=section["id"], name=section["name"], bounds=section["bounds"])
            graph, geometry, source_index, audit = compile_section(opl, products, Footprint(geometry, dividers), info, supplement)
            catalog["sections"].append(write_section(staging, section, graph, geometry))
            observations.append({"section": section["id"], "counts": audit["counts"],
                                 "peakRssBytes": peak_rss(), "elapsedSeconds": time.perf_counter() - section_started})
            if audit_enabled:
                write_json(staging / "audit" / section["id"] / "source-index.json.gz", source_index, True)
                write_json(staging / "audit" / section["id"] / "audit.json.gz", audit, True)
            del graph, geometry, source_index, audit
        catalog["info"]["startCount"] = sum(section["startCount"] for section in catalog["sections"])
        if catalog["unavailable"]:
            catalog["info"]["limitations"].append(f"{len(catalog['unavailable'])} mountain section(s) are not prepared; searches disclose this incomplete coverage.")
        catalog["info"]["id"] = "mountains-" + hashlib.sha256(json_bytes(catalog)).hexdigest()
        write_json(staging / "catalog.json", catalog)
        write_json(staging / "provenance.json", {"plan": plan, "observations": observations,
                                                "elapsedSeconds": time.perf_counter() - started, "peakRssBytes": peak_rss()})
        if evidence(manifest) != proof:
            raise ValueError("Compiler or source manifest changed while building; no catalog was published")
        os.rename(staging, output)
    return catalog


def peak_rss():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if os.uname().sysname == "Darwin" else 1024)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "build"))
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=HERE / "sources.json")
    parser.add_argument("--max-segments", type=int, default=700_000)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--section", action="append")
    parser.add_argument("--audit", action="store_true")
    parser.add_argument("--base-url", help="Published directory URL for downloading the prepared sections")
    args = parser.parse_args()
    if args.max_segments < 1:
        parser.error("--max-segments must be positive")
    manifest = json.loads(args.manifest.read_text())
    if args.command == "plan":
        with tempfile.TemporaryDirectory(prefix="alpine-plan-") as temporary:
            plan = make_plan(manifest, args.source_root.resolve(), Path(temporary), args.max_segments)
        write_json(args.output, plan)
        print(json.dumps({"output": str(args.output), "sourceSegments": plan["sourceSegments"],
                          "cuts": [cut["ref"] for cut in plan["cuts"]],
                          "sections": [{key: section[key] for key in ("id", "name", "sourceSegments", "status")} for section in plan["sections"]]}, indent=2))
    else:
        if not args.plan:
            parser.error("build requires --plan")
        catalog = build_catalog(manifest, json.loads(args.plan.read_text()), args.source_root.resolve(), args.output.resolve(), args.section, args.audit, args.base_url)
        print(json.dumps({"output": str(args.output), "id": catalog["info"]["id"], "prepared": len(catalog["sections"]),
                          "unavailable": len(catalog["unavailable"]), "peakRssBytes": peak_rss()}, indent=2))


if __name__ == "__main__":
    main()
