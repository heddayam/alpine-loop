"""One offline source fixture exercises the whole compiler, not its own oracle."""
import gzip
import hashlib
import json
import subprocess
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
from graph import topology
from tiles import write_network


class FreshCompiler(unittest.TestCase):
    def test_source_topology_access_boundary_and_measured_climb(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            osm = XML.Element("osm", version="0.6")
            points = {1: (0, 0), 2: (.002, 0), 3: (.004, 0), 4: (.004, .004), 5: (0, .004),
                      9: (-.002, 0), 10: (0, -.002), 11: (.007, 0), 12: (0, .005), 13: (0, .0055),
                      14: (.005, .001), 15: (.005, .002), 16: (.001, -.0005), 17: (.002, -.0005),
                      18: (.001, .005), 19: (.002, .005), 20: (.003, .003),
                      30: (.001, .001), 31: (.002, .001), 32: (.002, .002), 40: (-.002, .0025), 41: (.007, .0025),
                      50: (.003, .005), 51: (.004, .005), 52: (.005, .005), 53: (.0055, .005),
                      60: (.005, .0005), 61: (.005, .0015), 62: (.005, .0025), 63: (.005, .0035),
                      64: (.005, .0045), 65: (.0045, .0055), 66: (.0035, .0055), 67: (.0025, .0055),
                      68: (.0055, .0045), 70: (.0005, .0055), 71: (.001, .0055), 72: (.0015, .0055)}
            for identity, (lon, lat) in points.items():
                node = XML.SubElement(osm, "node", id=str(identity), version="1", lon=str(lon), lat=str(lat))
                tags = {1: {"highway": "trailhead", "name": "Loop, 100% — ridge"},
                        4: {"highway": "trailhead", "name": "Seasonal entrance", "foot:conditional": "yes @ (May-Sep)"},
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
            way(105, [1, 16, 17, 3], {"highway": "unclassified", "name": "Bessemer-like connection",
                                    "foot": "yes", "motor_vehicle": "private", "oneway": "yes"})
            way(106, [5, 18, 19, 4], {"highway": "footway", "foot": "yes", "oneway:foot": "yes"})
            way(107, [30, 31, 32, 30], {"highway": "pedestrian", "area": "yes"})
            way(108, [30, 31, 32], {"highway": "path", "construction": "yes"})
            way(109, [40, 41], {"highway": "path", "foot": "yes"})
            way(110, [1, 2, 3, 4, 5, 1], {"amenity": "parking", "access": "yes", "name": "Loop parking"})
            way(111, [12, 13, 20, 12], {})
            way(112, [50, 51], {"highway": "path", "foot": "yes"})
            way(113, [51, 52], {"highway": "footway", "footway": "sidewalk", "foot": "yes"})
            way(114, [52, 53], {"highway": "footway", "footway": "crossing", "foot": "yes"})
            way(115, [52, 53], {"highway": "path", "foot": "yes"})
            way(116, [3, 60], {"highway": "service", "access": "yes", "foot": "no"})
            way(117, [3, 61], {"highway": "motorway", "access": "yes"})
            way(118, [3, 62], {"highway": "motorway_link", "foot:conditional": "yes @ (May-Sep)"})
            way(119, [3, 63], {"highway": "trunk", "motorroad": "yes", "access": "yes"})
            way(120, [3, 64], {"highway": "motorway", "foot": "yes", "foot:backward": "no"})
            way(121, [3, 65], {"highway": "primary", "motorroad": "yes", "foot:forward": "yes"})
            way(122, [3, 66], {"highway": "trunk"})
            way(123, [3, 67], {"highway": "motorway_link", "access": "private", "foot": "yes"})
            way(124, [53, 68], {"highway": "residential"})
            way(125, [50, 70, 71], {"highway": "track", "name": "Naches-like Trail", "surface": "unpaved",
                                   "foot": "designated", "motor_vehicle": "yes", "oneway": "yes"})
            way(126, [71, 72], {"highway": "track", "foot": "yes", "motor_vehicle": "private", "oneway:foot": "yes"})
            # A relation is neither required for way 105 nor permission for 117.
            relation = XML.SubElement(osm, "relation", id="200", version="1")
            XML.SubElement(relation, "member", type="way", ref="117", role="")
            XML.SubElement(relation, "tag", k="route", v="hiking")
            XML.SubElement(relation, "tag", k="type", v="route")
            parking = XML.SubElement(osm, "relation", id="201", version="1")
            XML.SubElement(parking, "member", type="way", ref="111", role="outer")
            for key, value in {"type": "multipolygon", "amenity": "parking", "access": "yes"}.items():
                XML.SubElement(parking, "tag", k=key, v=value)
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
            self.assertIn("n51", lineage["nodeIds"], "A degree-two trail/sidewalk transition remains a routing node")
            self.assertNotIn("n52", lineage["nodeIds"], "Sidewalk and crossing retain the same connector role and can compact")
            all_nodes = {node for trail in lineage["trails"] for node in trail["nodes"]}
            self.assertTrue({"n2", "n16", "n17"} <= all_nodes)
            self.assertTrue({"n9", "n10", "n11", "n12", "n13", "n30", "n31", "n32"}.isdisjoint(all_nodes))
            self.assertEqual(len(audit["frontiers"]), 5, "Paths and ordinary roads crossing the footprint retain their boundary intersections")
            self.assertTrue(all(lineage["nodeIds"][start["node"]] not in audit["frontiers"] for start in graph["starts"]))
            self.assertEqual(audit["unresolvedPois"][0]["id"], "n20")
            starts = {lineage["nodeIds"][start["node"]]: start for start in graph["starts"]}
            self.assertEqual(set(starts), {"n1", "n3", "n4", "n5", "n50"}, "Distinct parking exits and road/track-to-trail contacts remain")
            self.assertNotIn("n53", starts, "An explicit sidewalk/crossing-to-road contact is not a trail entrance")
            self.assertEqual(starts["n50"]["access"], "unknown", "Track-to-trail contact is not proof of legal arrival or parking")
            self.assertNotIn("n71", starts, "Two connected tracks do not establish a trail entrance")
            self.assertEqual(starts["n1"]["access"], "public", "Missing trailhead permission must not erase its parking's public evidence")
            self.assertEqual(starts["n4"]["access"], "unknown", "Public parking does not erase a node's conditional restriction")
            self.assertEqual(audit["redundantContacts"], [{"node": "n2", "retained": "n1", "parking": "w110", "ways": ["100"]}])
            self.assertTrue(any(poi["id"] == "r201" and poi["nodes"] == ["12", "13", "20", "12"] for poi in audit["unresolvedPois"]),
                            "Parking multipolygon members are retained, but public parking cannot restore an explicitly blocked gate")
            source_edges = {}
            for edge in graph["edges"]:
                sources = {source["way"] for segment in lineage["trails"][edge["trail"]]["segments"] for source in segment["source"]}
                for source_way in sources:
                    source_edges.setdefault(source_way, []).append(edge)
            self.assertTrue({"116", "117", "118", "119"}.isdisjoint(source_edges),
                            "Foot prohibition and motor-only defaults remain closed despite generic access or relation membership")
            self.assertEqual({edge["access"] for edge in source_edges["105"]}, {"public"},
                             "Explicit foot permission overrides motor-vehicle restrictions without a hiking relation")
            for source_way in ("102", "125", "126"):
                self.assertTrue(all(geometry[edge["trail"]]["kind"] == "connector" for edge in source_edges[source_way]),
                                "A track remains a connector despite its trail name, unpaved surface, foot designation or vehicle restrictions")
                self.assertEqual({edge["access"] for edge in source_edges[source_way]}, {"public"})
            self.assertEqual(len(source_edges["125"]), 2, "A vehicle-oneway track retains walking connectivity in both directions")
            self.assertEqual([(lineage["nodeIds"][edge["from"]], lineage["nodeIds"][edge["to"]]) for edge in source_edges["126"]],
                             [("n71", "n72")], "Pedestrian-specific track direction still applies")
            self.assertTrue({"n70", "n71", "n72"} <= all_nodes, "Track geometry remains in the walking graph")
            self.assertTrue(all(geometry[edge["trail"]]["kind"] == "trail" for edge in source_edges["112"]))
            for source_way in ("101", "122", "124"):
                self.assertEqual({edge["access"] for edge in source_edges[source_way]}, {"unknown"},
                                 "Ordinary roads, including trunk without motorroad, retain unresolved walking access")
            for source_way, endpoint in (("120", "n64"), ("121", "n65")):
                directed = source_edges[source_way]
                self.assertEqual([(lineage["nodeIds"][edge["from"]], lineage["nodeIds"][edge["to"]], edge["access"]) for edge in directed],
                                 [("n3", endpoint, "public")], "Motor-only foot exceptions apply to the permitted direction only")
            self.assertEqual(len(source_edges["123"]), 2)
            self.assertEqual({edge["access"] for edge in source_edges["123"]}, {"public"},
                             "An explicit bidirectional foot exception overrides generic private access on a motorway link")
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
                    self.assertEqual(geometry[trail]["kind"], "connector")
                if "n52" in item["nodes"]:
                    self.assertEqual(geometry[trail]["kind"], "connector", "Explicit sidewalk/crossing wins over a duplicate generic path")
                    self.assertEqual({source["kind"] for segment in item["segments"] for source in segment["source"]}, {"trail", "connector"})
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
            # Same OSM segment clipped at a different location must not reuse a frontier identity.
            sparse = {"109": {"id": "109", "nodes": ["40", "41"], "tags": {"highway": "path", "foot": "yes"}}}
            source_points = {str(node): point for node, point in points.items()}
            _, original_points, _, _ = topology(sparse, [], {}, source_points, bounds)
            shifted_bounds = [-.0005, *bounds[1:]]
            _, shifted_points, _, _ = topology(sparse, [], {}, source_points, shifted_bounds)
            original_frontier = min(original_points, key=lambda node: original_points[node][0])
            shifted_frontier = min(shifted_points, key=lambda node: shifted_points[node][0])
            self.assertNotEqual(original_frontier, shifted_frontier)

            evidence = {"osm": hashlib.sha256(source.read_bytes()).hexdigest(), "dem": hashlib.sha256(dem.read_bytes()).hexdigest()}
            network = root / "network"
            manifest = write_network(network, graph, geometry, identity_evidence=evidence)
            repeat = write_network(root / "repeat", graph, geometry, identity_evidence=evidence)
            self.assertEqual(manifest, repeat, "Identical verified input and compiler produce identical gzip hashes and snapshot identity")
            self.assertEqual((network / "manifest.json").read_bytes(), (root / "repeat/manifest.json").read_bytes())
            self.assertEqual(graph["info"]["id"], "fixture", "Writer copies its parent's dataset metadata")
            self.assertNotEqual(manifest["info"]["id"], "fixture")
            self.assertEqual({path.relative_to(network).as_posix() for path in network.rglob("*.gz")}, set(manifest["files"]))
            self.assertFalse((network / "graph.json.gz").exists(), "No legacy whole runtime graph")
            cells, stored_geometry, stored_starts = {}, {}, {}
            for filename, record in manifest["files"].items():
                compressed = (network / filename).read_bytes()
                raw = gzip.decompress(compressed)
                self.assertEqual(record, {"bytes": len(compressed), "jsonBytes": len(raw), "sha256": hashlib.sha256(compressed).hexdigest()})
                value = json.loads(raw)
                if filename.startswith("graph/"):
                    cells[filename] = value
                    nodes = dict(value["nodes"])
                    for section in value["sections"]:
                        self.assertEqual(section["kind"], geometry[section["id"]]["kind"])
                        self.assertEqual(section["edges"], [[index, edge] for index, edge in enumerate(graph["edges"]) if edge["trail"] == section["id"]])
                        for _, edge in section["edges"]:
                            for node in (edge["from"], edge["to"]):
                                self.assertEqual(nodes[node], graph["nodes"][node], "Every copy retains both complete endpoints")
                elif filename.startswith("geometry/"):
                    for index, shape in value:
                        self.assertNotIn(index, stored_geometry, "Geometry has one owner")
                        stored_geometry[index] = shape
                else:
                    for index, start, position in value:
                        self.assertNotIn(index, stored_starts, "Starts have one owner")
                        self.assertEqual(position, graph["nodes"][start["node"]])
                        stored_starts[index] = start
            self.assertEqual([stored_geometry[index] for index in range(len(geometry))], geometry)
            self.assertEqual([stored_starts[index] for index in range(len(graph["starts"]))], graph["starts"])
            crossing_section = next(index for index, trail in enumerate(lineage["trails"]) if any(source["way"] == "109" for segment in trail["segments"] for source in segment["source"]))
            copies = [filename for filename, value in cells.items() if any(section["id"] == crossing_section for section in value["sections"])]
            self.assertEqual(copies, ["graph/-1_0.json.gz", "graph/0_0.json.gz"], "Negative floor cell and positive cell both discover the full crossing corridor")
            self.assertIn(crossing_section, dict(json.loads(gzip.decompress((network / "geometry/0_0.json.gz").read_bytes()))), "Crossing geometry belongs to its midpoint cell, not its first endpoint cell")
            self.assertEqual([filename for filename in manifest["files"] if filename.startswith("starts/")], ["starts/0_0.json.gz"])
            changed = [dict(shape, name="Changed name") if index == 0 else shape for index, shape in enumerate(geometry)]
            self.assertNotEqual(write_network(root / "changed", graph, changed, identity_evidence=evidence)["info"]["id"], manifest["info"]["id"], "Actual output facts determine the snapshot identity")
            inputs = dict(info, osm={"file": source.name, "sha256": evidence["osm"]},
                          elevation=[{"file": dem.name, "sha256": evidence["dem"], "bounds": [-.01, -.01, .01, .01]}])
            (root / "inputs.json").write_text(json.dumps(inputs))
            subprocess.run([sys.executable, str(Path(__file__).resolve().parents[2] / "tools/prepare/build.py"),
                            "--source-root", str(root), "--manifest", str(root / "inputs.json"), "--output", str(root / "published")],
                           check=True, capture_output=True, text=True)
            published = root / "published"
            runtime = json.loads((published / "manifest.json").read_text())
            provenance = json.loads((published / "audit/provenance.json").read_text())
            self.assertEqual(provenance["snapshotId"], runtime["info"]["id"])
            self.assertEqual({path.name for path in published.iterdir()}, {"manifest.json", "graph", "geometry", "starts", "audit"})
            self.assertFalse(any(filename.startswith("audit/") for filename in runtime["files"]), "Runtime manifest excludes source replay artifacts")
            self.assertEqual(json.loads(gzip.decompress((published / "audit/graph.json.gz").read_bytes()))["info"], runtime["info"])
            with rasterio.open(dem, "r+") as dataset:
                values[99:101, 99:101] = -9999
                dataset.write(values, 1)
            with self.assertRaisesRegex(ValueError, "Missing DEM"):
                Elevation([{"path": dem, "bounds": [-.01, -.01, .01, .01]}]).sample([(0, 0)])


if __name__ == "__main__":
    unittest.main()
