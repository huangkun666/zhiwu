interface WordElement {
  type: string;
  value?: string;
  children?: WordElement[];
}

function elementText(node: WordElement): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.type === 'tab') return '\t';
  if (node.type === 'break') return '\n';
  const children = (node.children ?? []).map(elementText);
  if (node.type === 'tableCell') return children.join('').trim().replace(/\s*\n+\s*/g, ' ');
  if (node.type === 'tableRow') return children.join(' | ');
  if (node.type === 'table') return children.join('\n') + '\n\n';
  return children.join('') + (node.type === 'paragraph' ? '\n\n' : '');
}

/** Mammoth's plain-text converter drops row and cell boundaries. Read its document tree before rendering. */
export async function extractDocxText<Input>(reader: {
  convertToHtml(input: Input, options: { transformDocument(doc: WordElement): WordElement }): Promise<unknown>;
}, input: Input): Promise<string> {
  let text = '';
  await reader.convertToHtml(input, { transformDocument(doc) {
    text = elementText(doc).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { ...doc, children: [] };
  } });
  return text;
}
