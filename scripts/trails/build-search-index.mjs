#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { partitionPrefixLength, segmentPartitionKey } from "./artifact-contract.mjs";

const DEFAULT_ARTIFACT_ROOT = resolve("data/trails/generated");
const DEFAULT_OUTPUT_ROOT = resolve("app/trails/indexes");

const ADVANCED_ROUTE_NAME =
  /(?:approach|scrambl|climb|climber|climbing|descent|the gunsight)/i;

const TRAIL_EXCEPTIONS = Object.freeze({
  "named-trail_0fe1a07a5c313956682f89eb": {
    notices: [
      "Hiking permission is unknown.",
      "The source describes seasonal winter use and possible summer trail use; verify current conditions before visiting.",
    ],
  },
  "named-trail_8fb704040434b8047e3edd34": {
    suppressed: true,
    suppressionReason: "Access and topology require independent confirmation.",
  },
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function summarizeHiking(segments) {
  if (segments.some(({ hiking }) => hiking === "blocked")) return "blocked";
  return segments.every(({ hiking }) => hiking === "allowed") ? "allowed" : "unknown";
}

function summarizeAccess(segments) {
  if (segments.some(({ access }) => access === "private")) return "private";
  return segments.every(({ access }) => access === "public") ? "public" : "unknown";
}

function summarizeStatus(segments) {
  if (segments.some(({ status }) => status === "closed")) return "closed";
  if (segments.some(({ status }) => status === "seasonal")) return "seasonal";
  if (segments.some(({ status }) => status === "unknown")) return "unknown";
  return "open";
}

function rounded(value) {
  return Number(value.toFixed(1));
}

function summarizeSegments(segments) {
  const minimums = segments.flatMap(({ minElevationMeters }) =>
    Number.isFinite(minElevationMeters) ? [minElevationMeters] : []);
  const maximums = segments.flatMap(({ maxElevationMeters }) =>
    Number.isFinite(maxElevationMeters) ? [maxElevationMeters] : []);
  const surfaces = [...new Set(segments.flatMap(({ surface }) => surface ? [surface] : []))]
    .sort((left, right) => left.localeCompare(right));
  return {
    hiking: summarizeHiking(segments),
    access: summarizeAccess(segments),
    status: summarizeStatus(segments),
    ...(surfaces.length > 0 ? { surfaces } : {}),
    ...(minimums.length > 0 && maximums.length > 0 ? {
      elevation: {
        minMeters: rounded(Math.min(...minimums)),
        maxMeters: rounded(Math.max(...maximums)),
      },
    } : {}),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readSegments(directory, index) {
  const segments = new Map();
  const prefixLength = partitionPrefixLength(index);
  for (const [prefix, shard] of Object.entries(index.shards)) {
    const content = await readFile(resolve(directory, shard.path), "utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      const segment = JSON.parse(line);
      if (segmentPartitionKey(segment.id, prefixLength) !== prefix) {
        throw new Error(`Segment ${segment.id} is stored in the wrong shard ${prefix}`);
      }
      segments.set(segment.id, segment);
    }
  }
  return { segments, prefixLength };
}

export async function buildTrailSearchIndex(regionId, options = {}) {
  const artifactRoot = resolve(options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT);
  const directory = resolve(artifactRoot, regionId);
  const [manifestText, namedPayload, segmentIndex] = await Promise.all([
    readFile(resolve(directory, "manifest.json"), "utf8"),
    readJson(resolve(directory, "named-trails.json")),
    readJson(resolve(directory, "segments/index.json")),
  ]);
  const manifest = JSON.parse(manifestText);
  if (manifest.region?.id !== regionId || namedPayload.regionId !== regionId ||
      segmentIndex.regionId !== regionId) {
    throw new Error(`Artifact region mismatch for ${regionId}`);
  }

  const { segments, prefixLength } = await readSegments(directory, segmentIndex);
  const trails = {};
  for (const trail of namedPayload.trails) {
    const trailSegments = trail.segmentIds.map((segmentId) => {
      const segment = segments.get(segmentId);
      if (!segment) throw new Error(`Missing segment ${segmentId} for ${trail.id}`);
      return segment;
    });
    const exception = TRAIL_EXCEPTIONS[trail.id] ?? {};
    trails[trail.id] = {
      ...summarizeSegments(trailSegments),
      routeClass: ADVANCED_ROUTE_NAME.test(trail.name) ? "advanced-climbing" : "hiking",
      ...exception,
    };
  }

  return {
    schemaVersion: 1,
    regionId,
    source: {
      generatedAt: manifest.generatedAt,
      manifestSha256: sha256(manifestText),
      namedTrailsSha256: manifest.artifacts?.["named-trails.json"]?.sha256,
      segmentsIndexSha256: manifest.artifacts?.["segments/index.json"]?.sha256,
      ...(manifest.schemaVersion >= 2 ? { segmentPartitionPrefixLength: prefixLength } : {}),
    },
    trails,
  };
}

export async function writeTrailSearchIndex(regionId, options = {}) {
  const outputRoot = resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT);
  const outputPath = resolve(outputRoot, `${regionId}.json`);
  const index = await buildTrailSearchIndex(regionId, options);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${stableJson(index)}\n`);
  return outputPath;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const regionId = process.argv.find((argument) => argument.startsWith("--region="))?.slice(9)
    ?? "yosemite-stanislaus";
  const outputPath = await writeTrailSearchIndex(regionId);
  process.stdout.write(`${fileURLToPath(pathToFileURL(outputPath))}\n`);
}
