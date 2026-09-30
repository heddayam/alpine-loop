"""Bilinear sample existing DEM pixels. Missing terrain is never zero gain."""
import math
from collections import defaultdict
from contextlib import ExitStack

import rasterio
from rasterio.warp import transform
from rasterio.windows import Window


class Elevation:
    def __init__(self, products):
        self.products = products

    def sample(self, points):
        values = [None] * len(points)
        missing = []
        with ExitStack() as stack:
            stack.enter_context(rasterio.Env(GDAL_CACHEMAX=64 * 1024 * 1024, PROJ_NETWORK="OFF"))
            rasters = [stack.enter_context(rasterio.open(product["path"])) for product in self.products]
            groups = defaultdict(list)
            for index, point in enumerate(points):
                matches = [tile for tile, product in enumerate(self.products)
                           if product["bounds"][0] <= point[0] < product["bounds"][2]
                           and product["bounds"][1] < point[1] <= product["bounds"][3]]
                if len(matches) != 1:
                    missing.append(point)
                else:
                    groups[matches[0]].append(index)
            for tile, indexes in sorted(groups.items()):
                raster = rasters[tile]
                print(f"DEM {self.products[tile]['path'].name}: {len(indexes):,} samples", flush=True)
                x, y = transform("EPSG:4326", raster.crs, [points[index][0] for index in indexes], [points[index][1] for index in indexes])
                inverse = ~raster.transform
                pixels = []
                for index, east, north in zip(indexes, x, y):
                    col, row = inverse * (east, north)
                    pixels.append((row - 0.5, col - 0.5, index))
                # Spatial order lets GDAL's own bounded block cache do the work.
                for row, col, index in sorted(pixels):
                    left, top = math.floor(col), math.floor(row)
                    dx, dy = col - left, row - top
                    if left < 0 or top < 0 or left + 1 >= raster.width or top + 1 >= raster.height:
                        missing.append(points[index])
                        continue
                    grid = raster.read(1, window=Window(left, top, 2, 2), masked=True)
                    weights = ((1 - dy) * (1 - dx), (1 - dy) * dx, dy * (1 - dx), dy * dx)
                    value = 0
                    valid = True
                    for cell, weight in zip(grid.reshape(-1), weights):
                        if weight <= 1e-12:
                            continue
                        if bool(getattr(cell, "mask", False)) or not math.isfinite(float(cell)):
                            valid = False
                            break
                        value += float(cell) * weight
                    if valid:
                        values[index] = value
                    else:
                        missing.append(points[index])
        if missing:
            raise ValueError(f"Missing DEM at {len(missing):,} samples; first coordinates: {missing[:20]}")
        return values
