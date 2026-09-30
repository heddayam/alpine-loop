import type { FeatureCollection, LineString } from "geojson";

function coordinateKey(coordinate: LineString["coordinates"][number] | undefined): string | undefined {
  return coordinate ? `${coordinate[0]},${coordinate[1]}` : undefined;
}

function normalizedTrailName(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? `named:${value.trim().toLocaleLowerCase("en-US")}`
    : "unnamed";
}

/**
 * Gives every physical edge a stable hover group for its visible viewport.
 * Named edges join only when their endpoints touch; disconnected trails that
 * happen to share a name remain separate. Unnamed edges join through ordinary
 * two-edge continuations but stop at branches, where continuing would invent
 * a trail identity the source data does not provide.
 */
export function groupContiguousTrailFeatures(
  collection: FeatureCollection<LineString>,
): FeatureCollection<LineString> {
  const features = collection.features;
  const parents = features.map((_, index) => index);
  const endpointOwners = new Map<string, number[]>();

  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  features.forEach((feature, index) => {
    const name = normalizedTrailName(feature.properties?.name);
    const coordinates = feature.geometry.coordinates;
    for (const endpoint of [coordinateKey(coordinates[0]), coordinateKey(coordinates.at(-1))]) {
      if (!endpoint) continue;
      const key = `${name}\u0000${endpoint}`;
      const owners = endpointOwners.get(key) ?? [];
      owners.push(index);
      endpointOwners.set(key, owners);
    }
  });
  for (const [key, owners] of endpointOwners) {
    const unnamed = key.startsWith("unnamed\u0000");
    if (unnamed && owners.length !== 2) continue;
    const first = owners[0];
    if (first === undefined) continue;
    for (const owner of owners.slice(1)) union(first, owner);
  }

  const groups = new Map<number, {
    distanceMeters: number;
    memberIds: string[];
    memberIndexes: number[];
  }>();
  features.forEach((feature, index) => {
    const root = find(index);
    const group = groups.get(root) ?? { distanceMeters: 0, memberIds: [], memberIndexes: [] };
    const distanceMeters = feature.properties?.distanceMeters;
    if (typeof distanceMeters === "number" && Number.isFinite(distanceMeters)) {
      group.distanceMeters += distanceMeters;
    }
    group.memberIds.push(String(feature.properties?.id ?? index));
    group.memberIndexes.push(index);
    groups.set(root, group);
  });
  for (const group of groups.values()) {
    group.memberIds.sort();
  }

  const mergedFeatures: FeatureCollection<LineString>["features"] = [];
  for (const group of groups.values()) {
    const groupId = `trail-group:${group.memberIds[0]!}`;
    const adjacency = new Map<string, number[]>();
    for (const index of group.memberIndexes) {
      const coordinates = features[index]!.geometry.coordinates;
      for (const endpoint of [coordinateKey(coordinates[0]), coordinateKey(coordinates.at(-1))]) {
        if (!endpoint) continue;
        const incident = adjacency.get(endpoint) ?? [];
        incident.push(index);
        adjacency.set(endpoint, incident);
      }
    }

    const unused = new Set(group.memberIndexes);
    const appendChain = (firstIndex: number, startEndpoint: string) => {
      const chainCoordinates: LineString["coordinates"] = [];
      let currentIndex = firstIndex;
      let currentEndpoint = startEndpoint;
      while (unused.has(currentIndex)) {
        unused.delete(currentIndex);
        const edgeCoordinates = features[currentIndex]!.geometry.coordinates;
        const oriented = coordinateKey(edgeCoordinates[0]) === currentEndpoint
          ? edgeCoordinates
          : [...edgeCoordinates].reverse();
        chainCoordinates.push(...(chainCoordinates.length > 0 ? oriented.slice(1) : oriented));
        const nextEndpoint = coordinateKey(oriented.at(-1));
        if (!nextEndpoint) break;
        const incident = adjacency.get(nextEndpoint) ?? [];
        if (incident.length !== 2) break;
        const nextIndex = incident.find((index) => unused.has(index));
        if (nextIndex === undefined) break;
        currentIndex = nextIndex;
        currentEndpoint = nextEndpoint;
      }
      const firstFeature = features[firstIndex]!;
      mergedFeatures.push({
        ...firstFeature,
        properties: {
          ...firstFeature.properties,
          id: `${groupId}:chain:${mergedFeatures.length + 1}`,
          trailGroupId: groupId,
          distanceMeters: group.distanceMeters,
        },
        geometry: { type: "LineString", coordinates: chainCoordinates },
      });
    };

    for (const [endpoint, incident] of adjacency) {
      if (incident.length === 2) continue;
      for (const index of incident) {
        if (unused.has(index)) appendChain(index, endpoint);
      }
    }
    while (unused.size > 0) {
      const index = unused.values().next().value as number;
      const startEndpoint = coordinateKey(features[index]!.geometry.coordinates[0]);
      if (startEndpoint) appendChain(index, startEndpoint);
      else unused.delete(index);
    }
  }

  return { type: "FeatureCollection", features: mergedFeatures };
}
