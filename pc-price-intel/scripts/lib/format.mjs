// Plain-text rendering helpers. Agents should prefer --json; this is for humans and logs.

export function table(rows, cols) {
  if (!rows.length) return "(none)";
  const cells = rows.map((r) => cols.map((c) => String(typeof c.get === "function" ? c.get(r) : r[c.key] ?? "").replace(/\s+/g, " ")));
  const widths = cols.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i].length)));
  const line = (arr) => arr.map((s, i) => s.padEnd(widths[i])).join("  ").trimEnd();
  return [line(cols.map((c) => c.label)), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

export function bullet(lines) {
  return lines.filter(Boolean).map((l) => `- ${l}`).join("\n");
}
