import { parseCoordinates } from "./coordinates.js";

export function CoordinateSearch({ onLocate, disabled }: {
  onLocate: (center: [number, number]) => void;
  disabled: boolean;
}) {
  return <form className="coordinate-search" onSubmit={event => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("coordinates") as HTMLInputElement;
    const center = parseCoordinates(input.value);
    input.setCustomValidity(center ? "" : "Enter latitude, longitude, for example 47.5, -121.5, or 47°30′N 121°30′W.");
    if (center) onLocate(center);
    else input.reportValidity();
  }}>
    <input name="coordinates" type="text" aria-label="Go to coordinates" placeholder="Enter coordinates"
      disabled={disabled} autoComplete="off" spellCheck={false}
      onChange={event => event.currentTarget.setCustomValidity("")} />
  </form>;
}
