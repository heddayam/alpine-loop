"""Exact mountain geometry; no terrain classifier or invented road extension."""
import io
import json
import zipfile

import shapefile
from rasterio.warp import transform_geom
from shapely import LineString, MultiPolygon, Point, Polygon, get_parts, intersection, make_valid, prepared
from shapely.geometry import mapping, shape


def polygons(geometry):
    return [part for part in get_parts(geometry) if isinstance(part, Polygon)]


def multipolygon(geometry):
    if isinstance(geometry, Polygon):
        return MultiPolygon([geometry])
    if isinstance(geometry, MultiPolygon):
        return geometry
    return MultiPolygon(polygons(geometry))


def boundary(geometry):
    return json.loads(json.dumps(mapping(multipolygon(geometry))))


def inventory(file, field, value):
    """Read one selected record, respecting the archive's declared CRS."""
    with zipfile.ZipFile(file) as archive:
        stem = next(name[:-4] for name in archive.namelist() if name.endswith(".shp") and not name.startswith("__MACOSX/"))
        reader = shapefile.Reader(shp=io.BytesIO(archive.read(stem + ".shp")),
                                  shx=io.BytesIO(archive.read(stem + ".shx")),
                                  dbf=io.BytesIO(archive.read(stem + ".dbf")), encoding="utf8")
        crs = archive.read(stem + ".prj").decode()
        for item in reader.iterShapeRecords():
            record = item.record.as_dict()
            if str(record[field]).strip() == str(value):
                geometry = transform_geom(crs, "EPSG:4326", item.shape.__geo_interface__)
                return multipolygon(make_valid(shape(geometry))), record
    raise ValueError(f"No {field}={value} in {file}")


class Footprint:
    def __init__(self, geometry, dividers=()):
        self.geometry = multipolygon(geometry)
        if self.geometry.is_empty or not self.geometry.is_valid:
            raise ValueError("Footprint must be a nonempty valid polygon")
        self.bounds = self.geometry.bounds
        self.prepared = prepared.prep(self.geometry)
        self.dividers = tuple(dividers)

    def covers(self, point):
        return self.prepared.covers(Point(point[:2]))

    def intersects(self, a, b):
        return self.prepared.intersects(LineString([a[:2], b[:2]]))

    def intervals(self, a, b):
        """Clip even sparse segments through holes and multiple components.

        Shared source nodes remain shared within this section. Generated
        endpoints retain exact fractions and cannot become invented starts.
        A selected highway is a hard boundary at every grade and has no walk
        edges of its own, even if its source explicitly admits pedestrians.
        """
        line = LineString([a[:2], b[:2]])
        if line.length == 0 or not self.prepared.intersects(line):
            return []
        if self.prepared.contains(line) and not any(divider.covers(line) for divider in self.dividers):
            return [(0.0, 1.0)]
        clipped = intersection(line, self.geometry)
        intervals = []
        for part in get_parts(clipped):
            if not isinstance(part, LineString) or part.length == 0:
                continue
            if any(divider.covers(part) for divider in self.dividers):
                continue
            low, high = sorted(line.project(Point(point), normalized=True) for point in (part.coords[0], part.coords[-1]))
            # Preserve original node identities despite floating point overlay.
            low = 0.0 if low < 1e-12 else low
            high = 1.0 if high > 1 - 1e-12 else high
            if low < high:
                intervals.append((low, high))
        return sorted(intervals)


def as_footprint(value):
    if isinstance(value, Footprint):
        return value
    # A rectangular fixture is still useful for independent access tests.
    if isinstance(value, (list, tuple)):
        from shapely import box
        return Footprint(box(*value))
    return Footprint(shape(value))
