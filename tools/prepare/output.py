"""Three complete files per independently compiled mountain section."""
import gzip
import hashlib
import io
import json
from contextlib import nullcontext


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"


def write_json(file, value, compressed=False):
    file.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    with file.open("wb") as destination:
        output = gzip.GzipFile(fileobj=destination, mode="wb", filename="", compresslevel=6, mtime=0) if compressed else nullcontext(destination)
        with output as stream, io.BufferedWriter(stream) as buffered:
            for part in encoder.iterencode(value):
                data = part.encode()
                buffered.write(data)
                size += len(data)
            buffered.write(b"\n")
    with file.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"bytes": file.stat().st_size, "jsonBytes": size + 1, "sha256": digest}


def write_section(directory, section, graph, geometry):
    shapes = [{key: value for key, value in item.items() if key != "kind"} for item in geometry]
    values = {"graph": {"graph": graph, "trails": [{"name": item["name"], "kind": item["kind"]} for item in geometry]},
              "starts": [[start, graph["nodes"][start["node"]]] for start in graph["starts"]], "geometry": shapes}
    files = {}
    for family, value in values.items():
        path = f"sections/{section['id']}/{family}.json.gz"
        files[family] = {"path": path, **write_json(directory / path, value, True)}
        if files[family]["bytes"] > 128 * 1024 * 1024 or files[family]["jsonBytes"] > 512 * 1024 * 1024:
            raise ValueError(f"Prepared {family} exceeds the runtime file-size limit; choose a smaller section capacity")
    return {key: section[key] for key in ("id", "regionId", "name", "bounds", "boundary", "sourceSegments")} | {
        "startCount": len(graph["starts"]), "files": files}
