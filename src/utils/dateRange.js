/** Date-only exam dates belong to the user's local calendar, not UTC. */
export function localDateKey(input) {
  if (!input) return "";
  const value = typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)
    ? new Date(`${input}T00:00:00`)
    : new Date(input);
  if (Number.isNaN(value.getTime())) return "";
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function isInDateRange(input, days, now = new Date()) {
  const key = localDateKey(input);
  if (!key) return false;
  if (!days) return true;
  const start = new Date(now);
  start.setDate(start.getDate() - days + 1);
  return key >= localDateKey(start) && key <= localDateKey(now);
}
