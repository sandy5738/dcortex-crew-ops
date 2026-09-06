/**
 * Minimal markdown renderer for advisor answers: headings, bold/italic,
 * inline code, bullet/numbered lists, pipe tables, paragraphs.
 *
 * Written by hand rather than pulling react-markdown (plus remark-gfm,
 * plus ~30 transitive deps) for the five constructs the model emits.
 * Tables are common in /chat answers, so they get first-class support.
 */
import React from "react";

interface InlineNode {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Order matters: code first (its content is literal), then bold, then italic.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push({ text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith("**")) nodes.push({ text: tok.slice(2, -2), bold: true });
    else nodes.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push({ text: text.slice(last) });
  return nodes;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return parseInline(text).map((n, i) => {
    if (n.code)
      return (
        <code key={`${keyPrefix}-c${i}`} className="md-code">
          {n.text}
        </code>
      );
    if (n.bold)
      return (
        <strong key={`${keyPrefix}-b${i}`}>{n.text}</strong>
      );
    if (n.italic)
      return (
        <em key={`${keyPrefix}-i${i}`}>{n.text}</em>
      );
    return <React.Fragment key={`${keyPrefix}-t${i}`}>{n.text}</React.Fragment>;
  });
}

function isDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function renderMarkdown(src: string): React.ReactNode {
  const lines = src.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    out.push(
      <p key={`p${key++}`} className="md-p">
        {renderInline(buf.join(" "), `p${key}`)}
      </p>,
    );
    buf.length = 0;
  };

  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph(para);
      i++;
      continue;
    }

    // Headings
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushParagraph(para);
      const level = h[1].length;
      const cls = ["md-h1", "md-h2", "md-h3", "md-h4"][level - 1];
      out.push(
        React.createElement(
          `h${level + 1}`,
          { key: `h${key++}`, className: cls },
          renderInline(h[2], `h${key}`),
        ),
      );
      i++;
      continue;
    }

    // Pipe table: header row + divider row
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      isDivider(lines[i + 1])
    ) {
      flushParagraph(para);
      const headers = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        <div key={`tbl${key++}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((cell, ci) => (
                  <th key={`th${ci}`}>{renderInline(cell, `th${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={`tr${ri}`}>
                  {headers.map((_, ci) => (
                    <td key={`td${ri}-${ci}`}>
                      {renderInline(row[ci] ?? "", `td${ri}${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Bullet list
    if (/^[-*•]\s+/.test(trimmed)) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={`ul${key++}`} className="md-ul">
          {items.map((item, ii) => (
            <li key={`li${ii}`} className="md-li">
              {renderInline(item, `li${ii}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      out.push(
        <ol key={`ol${key++}`} className="md-ol">
          {items.map((item, ii) => (
            <li key={`oli${ii}`} className="md-li">
              {renderInline(item, `oli${ii}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    para.push(trimmed);
    i++;
  }

  flushParagraph(para);
  return <>{out}</>;
}
