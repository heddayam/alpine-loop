"""Bilinear sample existing DEM pixels. Missing terrain is never zero gain."""
import math
from collections import defaultdict
from contextlib import ExitStack

import rasterio
from rasterio.warp import transform
from rasterio.windows import Window


class Elevation:
    def __init__(self, products, supplement=()):
        self.products = products
        self.supplement = supplement
        self.supplement_samples = 0

    def sample(self, points):
        values = self._sample(points, self.products)
        gaps = [index for index, value in enumerate(values) if value is None]
        if gaps and self.supplement:
            additional = self._sample([points[index] for index in gaps], self.supplement)
            for index, value in zip(gaps, additional):
                if value is not None:
                    values[index] = value
                    self.supplement_samples += 1
        missing = [points[index] for index, value in enumerate(values) if value is None]
        if missing:
            raise ValueError(f"Missing DEM at {len(missing):,} samples; first coordinates: {missing[:20]}")
        return values

    def _sample(self, points, products):
        values = [None] * len(points)
        with ExitStack() as stack:
            stack.enter_context(rasterio.Env(GDAL_CACHEMAX=64 * 1024 * 1024, PROJ_NETWORK="OFF"))
            rasters = [stack.enter_context(rasterio.open(product["path"])) for product in products]
            groups = defaultdict(list)
            for index, point in enumerate(points):
                matches = [tile for tile, product in enumerate(products)
                           if product["bounds"][0] <= point[0] < product["bounds"][2]
                           and product["bounds"][1] < point[1] <= product["bounds"][3]]
                if len(matches) > 1:
                    raise ValueError(f"Ambiguous overlapping DEM products at {point}")
                if matches:
                    groups[matches[0]].append(index)
            for tile, indexes in sorted(groups.items()):
                raster = rasters[tile]
                print(f"DEM {products[tile]['path'].name}: {len(indexes):,} samples", flush=True)
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
        return values
