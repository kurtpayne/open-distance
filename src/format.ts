export type Units = "imperial" | "metric";

export function formatDistance(meters: number, units: Units): string {
  if (units === "metric") {
    if (meters < 1000) return `${Math.round(meters)} m`;
    const km = meters / 1000;
    return `${km.toFixed(km < 10 ? 1 : 0)} km`;
  }
  const feet = meters * 3.28084;
  if (feet < 528) return `${Math.round(feet)} ft`;
  const miles = meters / 1609.344;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.round(seconds));
    return `${s} sec${s === 1 ? "" : "s"}`;
  }
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min${totalMin === 1 ? "" : "s"}`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (mins === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${mins} min${mins === 1 ? "" : "s"}`;
}
