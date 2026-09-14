/**
 * A receipt is a titled list of sections, each a list of label/value rows.
 * The same receipt renders as terminal text, Markdown (for a post), or JSON
 * (for scripts). Values are strings or bigints; bigints are serialised as
 * decimal strings so nothing is rounded on the way out.
 */

export type ReceiptValue = string | number | bigint | boolean | null;

export interface ReceiptRow {
  label: string;
  value: ReceiptValue;
  note?: string;
}

export interface ReceiptSection {
  title: string;
  rows: ReceiptRow[];
}

export interface Receipt {
  title: string;
  subtitle?: string;
  sections: ReceiptSection[];
  footnotes: string[];
  meta: Record<string, ReceiptValue>;
}

export type ReceiptFormat = "text" | "markdown" | "json";

export function renderReceipt(receipt: Receipt, format: ReceiptFormat): string {
  if (format === "json") return renderJson(receipt);
  if (format === "markdown") return renderMarkdown(receipt);
  return renderText(receipt);
}

function formatValue(value: ReceiptValue): string {
  if (value === null) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function renderText(receipt: Receipt): string {
  const labelWidths = receipt.sections.map((section) => Math.max(...section.rows.map((row) => row.label.length), 1));
  const width = Math.max(
    receipt.title.length + 4,
    (receipt.subtitle?.length ?? 0) + 4,
    ...receipt.sections.flatMap((section, index) =>
      section.rows.map((row) => labelWidths[index] + 2 + formatValue(row.value).length + (row.note ? row.note.length + 4 : 0) + 2),
    ),
    48,
  );
  const line = "─".repeat(width);
  const out: string[] = [];
  out.push(`┌${line}┐`);
  out.push(`│ ${receipt.title.padEnd(width - 1)}│`);
  if (receipt.subtitle) out.push(`│ ${receipt.subtitle.padEnd(width - 1)}│`);
  for (const section of receipt.sections) {
    out.push(`├${line}┤`);
    out.push(`│ ${section.title.toUpperCase().padEnd(width - 1)}│`);
    const labelWidth = labelWidths[receipt.sections.indexOf(section)];
    for (const row of section.rows) {
      const body = `${row.label.padEnd(labelWidth)}  ${formatValue(row.value)}${row.note ? `  (${row.note})` : ""}`;
      out.push(`│ ${body.padEnd(width - 1)}│`);
    }
  }
  if (receipt.footnotes.length) {
    out.push(`├${line}┤`);
    for (const note of receipt.footnotes) {
      for (const chunk of wrap(note, width - 3)) out.push(`│ ${chunk.padEnd(width - 1)}│`);
    }
  }
  out.push(`└${line}┘`);
  return out.join("\n");
}

function renderMarkdown(receipt: Receipt): string {
  const out: string[] = [`## ${receipt.title}`];
  if (receipt.subtitle) out.push("", `_${receipt.subtitle}_`);
  for (const section of receipt.sections) {
    out.push("", `### ${section.title}`, "", "| | |", "| --- | --- |");
    for (const row of section.rows) {
      const value = row.note ? `${formatValue(row.value)} _(${row.note})_` : formatValue(row.value);
      out.push(`| ${row.label} | ${value} |`);
    }
  }
  if (receipt.footnotes.length) {
    out.push("");
    for (const note of receipt.footnotes) out.push(`> ${note}`);
  }
  return out.join("\n");
}

function renderJson(receipt: Receipt): string {
  return JSON.stringify(receipt, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2);
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}
