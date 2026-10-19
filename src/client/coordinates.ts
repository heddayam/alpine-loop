// Unlabelled pairs use latitude, longitude, matching the map's copy action.
export function parseCoordinates(input: string): [number, number] | null {
  const text = input.trim().replace(/\u2212/g, "-").replace(/[′’]/g, "'").replace(/[″”]/g, '"')
    .replace(/^\s*[([]\s*/, "").replace(/\s*[)\]]\s*$/, "");
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  const decimal = text.match(new RegExp(`^(${number})\\s*(?:[,;]\\s*|\\s+)(${number})$`));
  let latitude: number, longitude: number;
  if (decimal) {
    latitude = Number(decimal[1]);
    longitude = Number(decimal[2]);
  } else {
    const angle = `${number}(?:\\s*°)?(?:\\s*\\d+(?:\\.\\d+)?(?:\\s*['′])?)?(?:\\s*\\d+(?:\\.\\d+)?(?:\\s*["″])?)?`;
    const component = `(?:[NSEW]\\s*${angle}|${angle}\\s*[NSEW])`;
    const directed = text.match(new RegExp(`^(${component})\\s*[,;]?\\s*(${component})$`, "i"));
    const parts = directed ? [directed[1]!, directed[2]!] : text.split(/[,;]/);
    if (parts.length !== 2) return null;
    const values = parts.map(part => {
      const match = part.trim().match(new RegExp(`^([NSEW])?\\s*(${number})(?:\\s*°)?(?:\\s*(\\d+(?:\\.\\d+)?)(?:\\s*')?)?(?:\\s*(\\d+(?:\\.\\d+)?)(?:\\s*")?)?\\s*([NSEW])?$`, "i"));
      if (!match || (match[1] && match[5])) return null;
      const degrees = Number(match[2]), minutes = Number(match[3] ?? 0), seconds = Number(match[4] ?? 0);
      const direction = (match[1] ?? match[5])?.toUpperCase();
      if (minutes >= 60 || seconds >= 60 || (match[4] && !Number.isInteger(minutes))
        || (match[3] && !Number.isInteger(degrees))) return null;
      if (direction && /^[+-]/.test(match[2]!)) return null;
      const magnitude = Math.abs(degrees) + minutes / 60 + seconds / 3600;
      return { value: magnitude * (direction ? /[SW]/.test(direction) ? -1 : 1 : match[2]!.startsWith("-") ? -1 : 1), direction };
    });
    const first = values[0], second = values[1];
    if (!first || !second || Boolean(first.direction) !== Boolean(second.direction)) return null;
    if (first.direction) {
      if (/[NS]/.test(first.direction) === /[NS]/.test(second.direction!)) return null;
      latitude = /[NS]/.test(first.direction) ? first.value : second.value;
      longitude = /[EW]/.test(first.direction) ? first.value : second.value;
    } else {
      latitude = first.value;
      longitude = second.value;
    }
  }
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? [longitude, latitude] : null;
}
