import { createHash, type Hash } from "node:crypto";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

/** Stable UTF-8 JSON used for every schema-6 topology content hash. */
export function canonicalTopologyJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function updateCanonicalHash(hash: Hash, value: unknown): void {
  if (Array.isArray(value)) {
    hash.update("[");
    value.forEach((item, index) => {
      if (index) hash.update(",");
      updateCanonicalHash(hash, item === undefined ? null : item);
    });
    hash.update("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    hash.update("{");
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
    entries.forEach(([key, item], index) => {
      if (index) hash.update(",");
      hash.update(JSON.stringify(key)); hash.update(":"); updateCanonicalHash(hash, item);
    });
    hash.update("}");
    return;
  }
  hash.update(JSON.stringify(value));
}

export function topologySha256(value: unknown): string {
  const hash = createHash("sha256");
  updateCanonicalHash(hash, value);
  return `sha256:${hash.digest("hex")}`;
}

