export type TableAlignment = "left" | "center" | "right";

export interface MarkdownTable {
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
  nextLine: number;
}

/**
 * Split a Markdown table row without treating escaped pipes or pipes inside inline code
 * as column separators. Returns null unless the row has at least two columns.
 */
export function splitMarkdownTableRow(line: string): string[] | null {
  if (!line.includes("|")) return null;

  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  let escaped = false;

  for (const ch of line.trim()) {
    if (escaped) {
      cell += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      cell += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());

  // Leading/trailing pipes create empty sentinel cells, not real columns.
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells.length >= 2 ? cells : null;
}

function separatorAlignment(cell: string): TableAlignment | null {
  const value = cell.replace(/\s+/g, "");
  if (!/^:?-{3,}:?$/.test(value)) return null;
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

/**
 * Parse only an unambiguous GFM-style table: a multi-column header followed immediately by
 * a same-width separator row made solely from `---`, with optional alignment colons.
 * Requiring that separator prevents ordinary prose containing pipes from becoming a table.
 */
export function parseMarkdownTable(lines: readonly string[], startLine: number): MarkdownTable | null {
  const header = splitMarkdownTableRow(lines[startLine] ?? "");
  const separator = splitMarkdownTableRow(lines[startLine + 1] ?? "");
  if (!header || !separator || header.length !== separator.length) return null;

  const alignments = separator.map(separatorAlignment);
  if (alignments.some((alignment) => alignment === null)) return null;

  const rows: string[][] = [];
  let nextLine = startLine + 2;
  while (nextLine < lines.length && lines[nextLine]!.trim() !== "") {
    const row = splitMarkdownTableRow(lines[nextLine]!);
    if (!row || row.length !== header.length) break;
    rows.push(row);
    nextLine++;
  }

  return {
    header,
    alignments: alignments as TableAlignment[],
    rows,
    nextLine,
  };
}
