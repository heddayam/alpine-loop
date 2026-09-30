"""One offline source fixture exercises the whole compiler, not its own oracle."""
import math
import sys
import tempfile
import unittest
import xml.etree.ElementTree as XML
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools/prepare"))
from build import build
from elevation import Elevation


class FreshCompiler(unittest.TestCase):
    def test_source_topology_access_boundary_and_measured_climb(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            osm = XML.Element("osm", version="0.6")
            points = {1: (0, 0), 2: (.002, 0), 3: (.004, 0), 4: (.004, .004), 5: (0, .004),
                      9: (-.002, 0), 10: (0, -.002), 11: (.007, 0), 12: (0, .005), 13: (0, .0055),
                      14: (.005, .001), 15: (.005, .002), 16: (.001, -.0005), 17: (.002, -.0005),
                      18: (.001, .005), 19: (.002, .005), 20: (.003, .003),
                      30: (.001, .001), 31: (.002, .001), 32: (.002, .002), 40: (-.002, .0025), 41: (.007, .0025)}
            for identity, (lon, lat) in points.items():
                node = XML.SubElement(osm, "node", id=str(identity), version="1", lon=str(lon), lat=str(lat))
                tags = {1: {"highway": "trailhead", "foot": "yes", "name": "Loop, 100% — ridge"},
                        12: {"barrier": "gate", "foot": "no"}, 20: {"amenity": "parking", "access": "yes"}}.get(identity, {})
                for key, value in tags.items():
                    XML.SubElement(node, "tag", k=key, v=value)
            def way(identity, refs, tags):
                element = XML.SubElement(osm, "way", id=str(identity), version="1")
                for reference in refs:
                    XML.SubElement(element, "nd", ref=str(reference))
                for key, value in tags.items():
                    XML.SubElement(element, "tag", k=key, v=value)
            way(100, [1, 2, 3, 4, 5, 1], {"highway": "path", "foot": "yes", "access": "private"})
            way(101, [9, 1, 10], {"highway": "residential"})
            way(102, [3, 11], {"highway": "track", "foot": "yes"})
            way(103, [5, 12, 13], {"highway": "footway", "foot": "yes"})
            way(104, [3, 14, 15, 3], {"highway": "cycleway"})
            way(105, [1, 16, 17, 3], {"highway": "service", "foot": "yes", "oneway": "yes"})
            way(106, [5, 18, 19, 4], {"highway": "footway", "foot": "yes", "oneway:foot": "yes"})
            way(107, [30, 31, 32, 30], {"highway": "pedestrian", "area": "yes"})
            way(108, [30, 31, 32], {"highway": "path", "construction": "yes"})
            way(109, [40, 41], {"highway": "path", "foot": "yes"})
            relation = XML.SubElement(osm, "relation", id="200", version="1")
            XML.SubElement(relation, "member", type="way", ref="105", role="")
            XML.SubElement(relation, "tag", k="route", v="hiking")
            XML.SubElement(relation, "tag", k="type", v="route")
            source = root / "source.osm"
            XML.ElementTree(osm).write(source, encoding="utf-8", xml_declaration=True)
            transform = from_origin(-.01, .01, .0001, .0001)
            rows, columns = np.indices((200, 200))
            values = (100 + 1000 * (-.01 + (columns + .5) * .0001) + 1000 * (.01 - (rows + .5) * .0001)).astype("float32")
            dem = root / "linear.tif"
            with rasterio.open(dem, "w", driver="GTiff", width=200, height=200, count=1,
                               dtype="float32", crs="EPSG:4326", transform=transform, nodata=-9999) as dataset:
                dataset.write(values, 1)
            bounds = [-.001, -.001, .006, .006]
            info = {"id": "fixture", "name": "Fixture", "bounds": bounds, "sourceDate": "2026-08-01",
                    "places": [], "limitations": [], "attribution": [], "startCount": 0}
            graph, geometry, lineage, audit = build(source, [{"path": dem, "bounds": [-.01, -.01, .01, .01]}], bounds, info)
            self.assertEqual(graph["starts"][0]["name"], "Loop, 100% — ridge")
            self.assertNotIn("n2", lineage["nodeIds"], "A source shape vertex must not become a routing junction")
            all_nodes = {node for trail in lineage["trails"] for node in trail["nodes"]}
            self.assertTrue({"n2", "n16", "n17"} <= all_nodes)
            self.assertTrue({"n9", "n10", "n11", "n12", "n13", "n30", "n31", "n32"}.isdisjoint(all_nodes))
            self.assertEqual(len(audit["frontiers"]), 3, "Sparse segments crossing the footprint are retained even with no source node inside")
            self.assertTrue(all(lineage["nodeIds"][start["node"]] not in audit["frontiers"] for start in graph["starts"]))
            self.assertEqual(audit["unresolvedPois"][0]["id"], "n20")
            self.assertEqual(len(graph["starts"]), 2, "Only actual road/trail contacts and mapped access become starts")
            for trail, item in enumerate(lineage["trails"]):
                directed = [edge for edge in graph["edges"] if edge["trail"] == trail]
                if "n2" in item["nodes"]:
                    self.assertEqual({edge["access"] for edge in directed}, {"public"})
                    self.assertAlmostEqual(sum(edge["gain"] for edge in directed), 4, places=4)
                    profile = geometry[trail]["coordinates"]
                    self.assertGreater(len(profile), 3)
                    self.assertTrue({(0, 0), (.002, 0), (.004, 0)} <= {tuple(point[:2]) for point in profile})
                if "n14" in item["nodes"]:
                    self.assertTrue(all(edge["access"] == "unknown" for edge in directed))
                if "n18" in item["nodes"]:
                    self.assertEqual(len(directed), 1)
                    self.assertEqual(lineage["nodeIds"][directed[0]["from"]], "n5")
                if "n16" in item["nodes"]:
                    self.assertEqual(len(directed), 2, "Vehicle oneway does not forbid walking back")
                for edge in directed:
                    elevations = [point[2] for point in geometry[trail]["coordinates"]]
                    if edge["reverse"]:
                        elevations.reverse()
                    self.assertAlmostEqual(edge["gain"], sum(max(0, b - a) for a, b in zip(elevations, elevations[1:])), places=7)
            for item in geometry:
                for lon, lat, elevation in item["coordinates"]:
                    self.assertTrue(bounds[0] - 1e-12 <= lon <= bounds[2] + 1e-12)
                    self.assertTrue(bounds[1] - 1e-12 <= lat <= bounds[3] + 1e-12)
                    self.assertAlmostEqual(elevation, 100 + 1000 * lon + 1000 * lat, places=4)
            with rasterio.open(dem, "r+") as dataset:
                values[99:101, 99:101] = -9999
                dataset.write(values, 1)
            with self.assertRaisesRegex(ValueError, "Missing DEM"):
                Elevation([{"path": dem, "bounds": [-.01, -.01, .01, .01]}]).sample([(0, 0)])


if __name__ == "__main__":
    unittest.main()
