import { useEffect, useState } from "react";

const narrowQuery = "(max-width: 760px)";

/** Narrow screens use sheets over the map and inline settings instead of popovers. */
export function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(narrowQuery).matches);
  useEffect(() => {
    const query = window.matchMedia(narrowQuery);
    const change = () => setNarrow(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return narrow;
}
