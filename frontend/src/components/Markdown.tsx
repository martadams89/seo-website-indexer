/**
 * Minimal markdown → React renderer for LLM answers. Covers the subset models
 * actually emit — headings, bold/italic, inline code, links, lists, rules —
 * with zero dependencies and no dangerouslySetInnerHTML.
 */
import React from 'react';

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1]) {
      out.push(<a key={k} href={m[3]} target="_blank" rel="noopener noreferrer" className="md-link">{m[2]}</a>);
    } else if (m[4]) {
      out.push(<strong key={k}>{m[5]}</strong>);
    } else if (m[6]) {
      out.push(<em key={k}>{m[7]}</em>);
    } else if (m[8]) {
      out.push(<code key={k} className="md-code">{m[9]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'list'; ordered: boolean; items: string[] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) { blocks.push({ kind: 'p', text: para.join('\n') }); para = []; }
  };
  const flushList = () => {
    if (list) { blocks.push({ kind: 'list', ...list }); list = null; }
  };

  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const oItem = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const uItem = /^\s*[-•*]\s+(.*)$/.exec(line);

    if (heading) {
      flushPara(); flushList();
      blocks.push({ kind: 'h', level: Math.min(heading[1].length, 4), text: heading[2] });
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara(); flushList();
      blocks.push({ kind: 'hr' });
    } else if (oItem) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(oItem[1]);
    } else if (uItem) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(uItem[1]);
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else if (list) {
      // continuation of the previous list item (e.g. a description line)
      list.items[list.items.length - 1] += '\n' + line.trim();
    } else {
      para.push(line);
    }
  }
  flushPara(); flushList();
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md-root">
      {blocks.map((b, i) => {
        if (b.kind === 'hr') return <hr key={i} className="md-hr" />;
        if (b.kind === 'h') {
          // h1–h4 in source render as h4–h6 sized headings inside a bubble
          const Tag = (`h${Math.min(b.level + 3, 6)}`) as keyof React.JSX.IntrinsicElements;
          return <Tag key={i} className="md-h">{renderInline(b.text, `h${i}`)}</Tag>;
        }
        if (b.kind === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className="md-list">
              {b.items.map((item, j) => {
                const [first, ...rest] = item.split('\n');
                return (
                  <li key={j}>
                    {renderInline(first, `l${i}-${j}`)}
                    {rest.length > 0 && <div className="md-li-cont">{renderInline(rest.join(' '), `lc${i}-${j}`)}</div>}
                  </li>
                );
              })}
            </Tag>
          );
        }
        return <p key={i} className="md-p">{renderInline(b.text, `p${i}`)}</p>;
      })}
    </div>
  );
}
