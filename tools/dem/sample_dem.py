from __future__ import annotations

import argparse
import json
import math
import re
import sys
from contextlib import ExitStack
from pathlib import Path

import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT


def collection_products(collection_path: Path) -> list[tuple[Path, tuple[int, int] | None]]:
    collection = json.loads(collection_path.read_text())
    products = collection.get("products")
    if not isinstance(products, list) or not products:
        raise ValueError("3DEP collection has no products")
    files = [(collection_path.parent / product["filePath"]).resolve() for product in products]
    missing = [str(file) for file in files if not file.is_file()]
    if missing:
        raise FileNotFoundError(f"3DEP products are missing: {', '.join(missing)}")
    result: list[tuple[Path, tuple[int, int] | None]] = []
    for product, file in zip(products, files, strict=True):
        match = re.search(r"\b([ns])(\d{1,2})([ew])(\d{1,3})\b", product.get("title", ""), re.I)
        if match:
            north = int(match[2]) * (1 if match[1].lower() == "n" else -1)
            west = int(match[4]) * (1 if match[3].lower() == "e" else -1)
            result.append((file, (west, north - 1)))
        else:
            result.append((file, None))
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


def sample(collection_path: Path, tile_owner: bool = False) -> None:
    points = coordinates()
    with ExitStack() as stack:
        stack.enter_context(rasterio.Env(GDAL_CACHEMAX=64 * 1024 * 1024))
        datasets = []
        tile_datasets = {}
        for file, tile in collection_products(collection_path):
            source = stack.enter_context(rasterio.open(file))
            dataset = stack.enter_context(WarpedVRT(source, crs="EPSG:4326", resampling=Resampling.bilinear))
            datasets.append(dataset)
            if tile_owner:
                if tile is None:
                    raise ValueError(f"3DEP product has no nominal tile: {file}")
                if tile in tile_datasets:
                    raise ValueError(f"duplicate 3DEP tile: {tile}")
                tile_datasets[tile] = dataset
        values: list[float | None] = [None] * len(points)
        if tile_owner:
            # Half-open tile ownership assigns exact integer seams to the
            # northern/eastern tile. Never use a neighboring raster as an
            # order-dependent fallback.
            for index, (lon, lat) in enumerate(points):
                dataset = tile_datasets.get((math.floor(lon), math.floor(lat)))
                if dataset is None:
                    continue
                bounds = dataset.bounds
                if not (bounds.left <= lon <= bounds.right and bounds.bottom <= lat <= bounds.top):
                    continue
                first = next(dataset.sample([(lon, lat)], masked=True))[0]
                if not bool(getattr(first, "mask", False)):
                    candidate = float(first)
                    if math.isfinite(candidate):
                        values[index] = candidate
        else:
            for dataset in datasets:
                bounds = dataset.bounds
                indexes = [
                    index for index, (lon, lat) in enumerate(points)
                    if values[index] is None and bounds.left <= lon <= bounds.right and bounds.bottom <= lat <= bounds.top
                ]
                if not indexes:
                    continue
                for index, sampled in zip(indexes, dataset.sample([points[index] for index in indexes], masked=True), strict=True):
                    first = sampled[0]
                    if not bool(getattr(first, "mask", False)):
                        candidate = float(first)
                        if math.isfinite(candidate):
                            values[index] = candidate
        for value in values:
            print("nan" if value is None else f"{value:.6f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline batched USGS 3DEP sampler for Alpine Loop")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--collection", type=Path)
    parser.add_argument("--tile-owner", action="store_true")
    args = parser.parse_args()
    if args.version:
        print(f"rasterio {rasterio.__version__}; GDAL {rasterio.__gdal_version__}")
        return
    if args.collection is None:
        parser.error("--collection is required unless --version is used")
    sample(args.collection.resolve(), args.tile_owner)


if __name__ == "__main__":
    main()
