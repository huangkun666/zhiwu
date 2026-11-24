import { useLayoutEffect, useRef } from 'react';
import type { ElementContent, Root } from 'hast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { SourceBlock } from '../../../server/src/shared/tutorSources';

interface MarkdownViewProps {
  content: string;
  className?: string;
  highlight?: SourceBlock;
  onOpenNote?: (href: string) => void;
}

function markedText(value: string, from: number, to: number): ElementContent[] {
  return [
    { type: 'text', value: value.slice(0, from) },
    { type: 'element', tagName: 'mark', properties: { 'data-source-target': true }, children: [
      { type: 'text', value: value.slice(from, to) },
    ] },
    { type: 'text', value: value.slice(to) },
  ];
}

// Markdown positions refer to the input string, even when several paragraphs have identical wording.
function markPassage({ content, block }: { content: string; block: SourceBlock }) {
  return (tree: Root) => {
    let found = false;
    let needsPlainText = false;
    function mark(node: ElementContent): ElementContent[] {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined || end <= block.start || start >= block.end) return [node];
      if (node.type === 'element') {
        node.children = node.children.flatMap(mark);
      } else if (node.type === 'text') {
        found = true;
        if (start >= block.start && end <= block.end) return markedText(node.value, 0, node.value.length);
        // Escapes, entities and generated elements can have different source and display offsets.
        if (content.slice(start, end) !== node.value) needsPlainText = true;
        else return markedText(node.value, Math.max(0, block.start - start), Math.min(node.value.length, block.end - start));
      }
      return [node];
    }
    for (const node of tree.children) {
      if (node.type === 'element') node.children = node.children.flatMap(mark);
    }
    if (!found || needsPlainText) {
      tree.children = [{ type: 'element', tagName: 'div', properties: { className: ['whitespace-pre-wrap'] },
        children: markedText(content, block.start, block.end) }];
    }
  };
}

export function MarkdownView({ content, className = '', highlight, onOpenNote }: MarkdownViewProps) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (highlight) container.current?.querySelector('[data-source-target]')?.scrollIntoView({ block: 'start' });
  }, [highlight]);
  return (
    <div ref={container} className={`zhiwu-prose ${className}`} onClick={onOpenNote && ((event) => {
      if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : undefined;
      if (link?.startsWith('?') && new URLSearchParams(link).get('note')) {
        event.preventDefault();
        onOpenNote(link);
      }
    })}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={highlight ? [rehypeKatex, [markPassage, { content, block: highlight }]] : [rehypeKatex]}>
        {content || ''}
      </ReactMarkdown>
    </div>
  );
}
