import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeSource } from '../dist/shared/knowledgePoints.js';
import { catalog, search, searchLibrary } from '../dist/shared/tutorSearch.js';
import { sourceBlocks } from '../dist/shared/tutorSources.js';

test('weak generated knowledge matches leave room for exact model numbers in the original', () => {
  const manual = {
    id: 'indexed', title: 'Machine overview',
    content: Array.from({ length: 14 }, (_, index) => `Pressure reference ${index}.`).join('\n\n'),
  };
  const blocks = sourceBlocks(manual);
  manual.knowledge_index = {
    source: knowledgeSource(manual), status: 'complete', processed: blocks.length, total: blocks.length,
    points: blocks.map(block => ({ id: String(block.index), title: block.text, aliases: [], answer: block.text, conditions: '',
      origins: [{ field: block.field, index: block.index, sig: block.sig, quote: block.text }] })),
  };
  const targeted = { id: 'specific', title: 'Product update', content: 'XJ-208 pressure must be adjusted once per month.' };
  assert.equal(search(catalog([manual, targeted]), 'XJ-208 pressure')[0].document.note.id, targeted.id);
});

test('global search locates a matching symbol without requiring a word token', () => {
  const note = { id: 'symbols', title: 'Instrument', content: 'Voltage threshold ± correction.' };
  const { passages } = searchLibrary([note], '±');
  assert.match(passages[0]?.text ?? '', /±/);
});
