from __future__ import annotations

import argparse
import json
import math
import sys
from contextlib import ExitStack
from pathlib import Path

import numpy as np
import rasterio

EARTH_RADIUS_M = 6371008.8


def collection_files(collection_path: Path) -> list[Path]:
    collection = json.loads(collection_path.read_text())
    products = collection.get("products")
    if not isinstance(products, list):
        raise ValueError("population collection has no products")
    files = [(collection_path.parent / product["filePath"]).resolve() for product in products]
    missing = [str(file) for file in files if not file.is_file()]
    if missing:
        raise FileNotFoundError(f"population products are missing: {', '.join(missing)}")
    return files


def empty_tile_bounds(collection_path: Path) -> list[tuple[float, float, float, float]]:
    """Bounds of tiles GHSL does not publish because they contain no population.

    These are genuinely zero, not unknown, so they must count as covered.
    Without them every access point in an unpopulated tile would read as
    'unknown' and fail the build.
    """
    collection = json.loads(collection_path.read_text())
    tiles = collection.get("emptyTiles") or []
    result = []
    for tile in tiles:
        bounds = tile["bounds"]
        result.append((float(bounds[0]), float(bounds[1]), float(bounds[2]), float(bounds[3])))
    return result


def coordinates() -> list[tuple[float, float]]:
    result: list[tuple[float, float]] = []
    for line_number, line in enumerate(sys.stdin, start=1):
        if not line.strip():
            continue
        try:
            lon_text, lat_text = line.split()
            lon, lat = float(lon_text), float(lat_text)
        except ValueError as error:
            raise ValueError(f"invalid coordinate at input line {line_number}") from error
        if not math.isfinite(lon) or not math.isfinite(lat):
            raise ValueError(f"non-finite coordinate at input line {line_number}")
        result.append((lon, lat))
    return result


def degree_span(radius_m: float, lat: float) -> tuple[float, float]:
    """Longitude/latitude half-spans that bound a radius_m disc at this latitude."""
    lat_span = math.degrees(radius_m / EARTH_RADIUS_M)
    cos_lat = math.cos(math.radians(lat))
    # Near the poles the longitude span degenerates; clamp to a full hemisphere.
    lon_span = 180.0 if cos_lat < 1e-6 else min(180.0, lat_span / cos_lat)
    return lon_span, lat_span


def disc_sum(dataset, lon: float, lat: float, radius_m: float) -> float:
    """Sum population counts in cells whose centre lies within radius_m of the point.

    GHS-POP stores absolute people-per-cell, so summing counts is correct even
    though a constant-degree cell covers less ground at higher latitudes. That
    is why this must not interpolate the way the DEM sampler does.
    """
    lon_span, lat_span = degree_span(radius_m, lat)
    left, bottom = lon - lon_span, lat - lat_span
    right, top = lon + lon_span, lat + lat_span
    bounds = dataset.bounds
    if right < bounds.left or left > bounds.right or top < bounds.bottom or bottom > bounds.top:
        return 0.0
    window = dataset.window(
        max(left, bounds.left), max(bottom, bounds.bottom),
        min(right, bounds.right), min(top, bounds.top),
    ).round_offsets().round_lengths()
    if window.width <= 0 or window.height <= 0:
        return 0.0
    data = dataset.read(1, window=window, masked=True).astype("float64")
    counts = np.ma.filled(data, 0.0)
    # GHS-POP encodes "no data" as a negative sentinel in some tiles.
    counts[~np.isfinite(counts) | (counts <= 0.0)] = 0.0
    if not counts.any():
        return 0.0

    transform = dataset.window_transform(window)
    rows = np.arange(counts.shape[0]) + 0.5
    columns = np.arange(counts.shape[1]) + 0.5
    cell_lon = transform.c + transform.a * columns
    cell_lat = transform.f + transform.e * rows
    phi1 = math.radians(lat)
    phi2 = np.radians(cell_lat)[:, None]
    d_phi = phi2 - phi1
    d_lambda = np.radians(cell_lon - lon)[None, :]
    a = np.sin(d_phi / 2) ** 2 + math.cos(phi1) * np.cos(phi2) * np.sin(d_lambda / 2) ** 2
    distance = 2 * EARTH_RADIUS_M * np.arcsin(np.minimum(1.0, np.sqrt(a)))
    return float(counts[distance <= radius_m].sum())


def sample(collection_path: Path, radius_m: float) -> None:
    points = coordinates()
    empties = empty_tile_bounds(collection_path)
    with ExitStack() as stack:
        datasets = []
        for file in collection_files(collection_path):
            dataset = stack.enter_context(rasterio.open(file))
            if dataset.crs is None or dataset.crs.to_epsg() != 4326:
                raise ValueError(f"population raster {file.name} is not EPSG:4326")
            datasets.append(dataset)
        for lon, lat in points:
            covered = any(
                west <= lon <= east and south <= lat <= north
                for west, south, east, north in empties
            )
            total = 0.0
            for dataset in datasets:
                bounds = dataset.bounds
                if bounds.left <= lon <= bounds.right and bounds.bottom <= lat <= bounds.top:
                    covered = True
                total += disc_sum(dataset, lon, lat, radius_m)
            # An uncovered point means the tile index missed a tile: report it as
            # unknown rather than silently claiming the area is unpopulated.
            print("nan" if not covered else f"{total:.6f}")


def describe(collection_path: Path) -> None:
    """Emit each raster's real georeferencing so the tile index can be verified."""
    for file in collection_files(collection_path):
        with rasterio.open(file) as dataset:
            bounds = dataset.bounds
            print(json.dumps({
                "fileName": file.name,
                "crs": None if dataset.crs is None else dataset.crs.to_string(),
                "epsg": None if dataset.crs is None else dataset.crs.to_epsg(),
                "bounds": [bounds.left, bounds.bottom, bounds.right, bounds.top],
                "width": dataset.width,
                "height": dataset.height,
            }))


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline batched GHS-POP radius sampler for Alpine Loop")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--describe", action="store_true")
    parser.add_argument("--collection", type=Path)
    parser.add_argument("--radius-m", type=float, default=2000.0)
    args = parser.parse_args()
    if args.version:
        print(f"rasterio {rasterio.__version__}; GDAL {rasterio.__gdal_version__}")
        return
    if args.collection is None:
        parser.error("--collection is required unless --version is used")
    if args.describe:
        describe(args.collection.resolve())
        return
    if not math.isfinite(args.radius_m) or args.radius_m <= 0:
        parser.error("--radius-m must be a positive number")
    sample(args.collection.resolve(), args.radius_m)


if __name__ == "__main__":
    main()
