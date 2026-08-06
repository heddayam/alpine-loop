import { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP reader for extracting a single member from a downloaded archive.
 *
 * GHSL ships each population tile as a ZIP containing the GeoTIFF plus
 * documentation. Rather than depend on a system `unzip` (whose version probe is
 * inconsistent across platforms) this reads the central directory directly.
 * Only the stored (0) and deflate (8) methods are supported, which is all the
 * GHSL archives use.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export type ZipEntry = { fileName: string; compressionMethod: number; localHeaderOffset: number; compressedSize: number; uncompressedSize: number };

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD record sits at the end, after an optional comment of up to 65535 bytes.
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("ZIP archive has no end-of-central-directory record");
}

export function listZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error(`ZIP central directory entry ${index} has an invalid signature`);
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ fileName, compressionMethod, localHeaderOffset, compressedSize, uncompressedSize });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset;
  if (buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
    throw new Error(`ZIP entry ${entry.fileName} has an invalid local header`);
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  const contents = entry.compressionMethod === 0 ? Buffer.from(compressed)
    : entry.compressionMethod === 8 ? inflateRawSync(compressed)
    : null;
  if (!contents) throw new Error(`ZIP entry ${entry.fileName} uses unsupported compression method ${entry.compressionMethod}`);
  if (contents.length !== entry.uncompressedSize) {
    throw new Error(`ZIP entry ${entry.fileName} decompressed to ${contents.length} bytes, expected ${entry.uncompressedSize}`);
  }
  return contents;
}

/** Extracts the single archive member matching `predicate`, failing when the match is not unique. */
export function extractSingleZipEntry(buffer: Buffer, predicate: (fileName: string) => boolean, label: string): { fileName: string; contents: Buffer } {
  const matches = listZipEntries(buffer).filter((entry) => predicate(entry.fileName));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label} in ZIP archive, found ${matches.length}`);
  return { fileName: matches[0].fileName, contents: readZipEntry(buffer, matches[0]) };
}
