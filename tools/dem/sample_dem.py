from __future__ import annotations

import argparse
import json
import math
import sys
from contextlib import ExitStack
from pathlib import Path

import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT


def collection_files(collection_path: Path) -> list[Path]:
    collection = json.loads(collection_path.read_text())
    products = collection.get("products")
    if not isinstance(products, list) or not products:
        raise ValueError("3DEP collection has no products")
    files = [(collection_path.parent / product["filePath"]).resolve() for product in products]
    missing = [str(file) for file in files if not file.is_file()]
    if missing:
        raise FileNotFoundError(f"3DEP products are missing: {', '.join(missing)}")
    return files


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


def sample(collection_path: Path) -> None:
    points = coordinates()
    with ExitStack() as stack:
        datasets = []
        for file in collection_files(collection_path):
            source = stack.enter_context(rasterio.open(file))
            datasets.append(stack.enter_context(WarpedVRT(source, crs="EPSG:4326", resampling=Resampling.bilinear)))
        for lon, lat in points:
            value: float | None = None
            for dataset in datasets:
                bounds = dataset.bounds
                if bounds.left <= lon <= bounds.right and bounds.bottom <= lat <= bounds.top:
                    sampled = next(dataset.sample([(lon, lat)], masked=True))[0]
                    if not bool(getattr(sampled, "mask", False)):
                        candidate = float(sampled)
                        if math.isfinite(candidate):
                            value = candidate
                            break
            print("nan" if value is None else f"{value:.6f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline batched USGS 3DEP sampler for Alpine Search")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--collection", type=Path)
    args = parser.parse_args()
    if args.version:
        print(f"rasterio {rasterio.__version__}; GDAL {rasterio.__gdal_version__}")
        return
    if args.collection is None:
        parser.error("--collection is required unless --version is used")
    sample(args.collection.resolve())


if __name__ == "__main__":
    main()
