import { parse, type DefaultTreeAdapterMap } from 'parse5';
type Node = DefaultTreeAdapterMap['node'];
export type HtmlElement = DefaultTreeAdapterMap['element'];
export const attr = (node: HtmlElement, name: string) => node.attrs.find((a) => a.name === name)?.value ?? '';
export function elements(input: string | Node): HtmlElement[] {
  const queue: Node[] = [typeof input === 'string' ? parse(input) : input],
    result: HtmlElement[] = [];
  while (queue.length) {
    const n = queue.pop()!;
    if ('tagName' in n) result.push(n);
    if ('childNodes' in n) for (let i = n.childNodes.length - 1; i >= 0; i--) queue.push(n.childNodes[i]);
  }
  return result;
}
export function nodeText(node: Node): string {
  const queue: Node[] = [node],
    parts: string[] = [];
  while (queue.length) {
    const n = queue.pop()!;
    if (n.nodeName === '#text') parts.push((n as DefaultTreeAdapterMap['textNode']).value);
    if ('childNodes' in n) for (let i = n.childNodes.length - 1; i >= 0; i--) queue.push(n.childNodes[i]);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
export function plainText(html: string): string {
  return nodeText(parse(html));
}

export function listingText(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
  if ('tagName' in node && node.tagName === 'br') return '\n';
  return 'childNodes' in node ? node.childNodes.map(listingText).join('') : '';
}
