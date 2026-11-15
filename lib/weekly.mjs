export function summarize(rows) {
  return { count: rows.length, minutes: rows.reduce((sum, row) => sum + row.minutes, 0) };
}
