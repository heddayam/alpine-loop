export type ParsedCoordinates = { lat: number; lng: number };

export function parseCoordinates(value: string): ParsedCoordinates | null {
  const match = value
    .trim()
    .match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*[, ]\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
