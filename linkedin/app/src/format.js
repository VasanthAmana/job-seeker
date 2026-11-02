"use strict";
// Output rendering for the "run alerts" workflow: every tool result is a
// compact fixed-width table for a human, plus the same data as JSON for a
// model to rank. Pure module.

const ELLIPSIS = "…";

function truncate(text, width) {
  const s = String(text === null || text === undefined ? "" : text);
  if (s.length <= width) return s;
  return s.slice(0, Math.max(1, width - 1)) + ELLIPSIS;
}

// headers: ["TITLE", ...]; rows: arrays of cell values. Columns are sized to
// content but capped (default 34 chars) so a long job title never wrecks the
// table; a blank string row renders as an empty table with a dash line.
function table(headers, rows, { maxColWidth = 34, minColWidth = 3 } = {}) {
  const cols = headers.length;
  const widths = [];
  for (let c = 0; c < cols; c++) {
    let w = String(headers[c]).length;
    for (const row of rows) {
      w = Math.max(w, String(row[c] === null || row[c] === undefined ? "" : row[c]).length);
    }
    widths.push(Math.max(minColWidth, Math.min(maxColWidth, w)));
  }
  const line = (cells) =>
    cells.map((cell, c) => truncate(cell, widths[c]).padEnd(widths[c])).join("  ").trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((row) => line(row.map((c) => (c === null || c === undefined ? "" : c))));
  return [line(headers), sep, ...body].join("\n");
}

// The two MCP text blocks for a successful tool result. Page-derived data is
// wrapped as untrusted content so the calling model treats it as data, never
// instructions (Zook's rule 4).
function renderToolResult(payload, tableText) {
  return [
    { type: "text", text: tableText },
    { type: "text", text: JSON.stringify({ untrusted_page_content: payload }, null, 2) },
  ];
}

module.exports = { table, renderToolResult, truncate };
