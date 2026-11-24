import { splitLegacyChatExcerpts } from './noteContent.js';
import type { Document } from './tutorSearch.js';

export interface TutorNoteEdit {
  noteId: string;
  title: string;
  updatedAt: string;
  operation: 'replace' | 'append' | 'rename';
  before: string;
  after: string;
}

const draftBlock = /(?:^|\n)[ \t]*\x60{3}zhiwu-edit[^\S\n]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*\x60{3}(?=\s|$)|$)/gi;
const editComment = /<!--zhiwu-edit:[^<>\s]*(?:-->|$)/g;
const maxText = 16000;

export function stripTutorNoteEdit(content: string) {
  return content.replace(draftBlock, '').replace(editComment, '');
}

export function tutorNoteEditMarker(proposal: TutorNoteEdit) {
  return '<!--zhiwu-edit:' + encodeURIComponent(JSON.stringify(proposal)).replace(/-/g, '%2D') + '-->';
}

export function readTutorNoteEdit(content: string): TutorNoteEdit | undefined {
  const match = /<!--zhiwu-edit:([^<>\s]+?)-->\s*$/.exec(content);
  if (!match || match[1].length > 400000) return;
  try {
    const p = JSON.parse(decodeURIComponent(match[1])) as TutorNoteEdit;
    if (p && ['replace', 'append', 'rename'].includes(p.operation) &&
        [p.noteId, p.title, p.updatedAt].every(v => typeof v === 'string' && v.length > 0) &&
        [p.before, p.after].every(v => typeof v === 'string' && v.length <= maxText)) return p;
  } catch { /* Ignore malformed or obsolete message metadata. */ }
}

export function applyTutorBodyEdit(content: string, proposal: TutorNoteEdit) {
  const body = splitLegacyChatExcerpts(content).body;
  const index = body.indexOf(proposal.before);
  if (proposal.operation !== 'replace' || !proposal.before.trim() || index < 0 ||
      body.indexOf(proposal.before, index + 1) !== -1) throw new Error('无法唯一定位原文，请重新生成修改建议');
  return content.slice(0, index) + proposal.after + content.slice(index + proposal.before.length);
}

export function isNoteEditRequest(question: string, hasCitedNote = false) {
  if (/(?:怎么|如何|怎样).{0,5}(?:编辑|修改|改笔记|追加)|(?:不要|别|不用|无需|先不)(?:再|动手)?(?:修改|编辑|改|写入|追加|保存)|\b(?:how (?:do|can) I|how to|do not|don['’]t(?: actually)?)\s+(?:edit|amend|update|change|rename|append|replace)\b/i.test(question)) return false;
  const target = hasCitedNote || /笔记(?!本电脑)|《[^》]+》|正文|摘录|\b(?:notes?|notebooks?)\b/i.test(question);
  return target && /改成|改为|改名|重命名|改一下|改掉|改写|编辑|修改|更正|修订|替换|追加|添加|补(?:充)?到|加(?:入|到|进)|(?:写|存|保存)(?:入|进|到)|更新.{0,12}(?:笔记|正文|《)|\b(?:edit|update|amend|correct|change|replace|rewrite|append|rename|add)\b/i.test(question);
}

// A proposal can target only one note resolved in this turn's allowed search scope.
export function editTarget(docs: Document[], question: string, citedIds: Set<string>, matched: Set<Document>, priorCitation: boolean) {
  const names = [...question.matchAll(/《([^》]+)》/g)].map(m => m[1].trim().toLowerCase());
  const lower = question.toLowerCase();
  const named = docs.filter(d => [d.note.title, d.note.source_filename].some(value => {
    const name = value?.trim().toLowerCase();
    return name && (names.length ? names.includes(name) : lower.includes(name));
  }));
  if (names.length || named.length) return named.length === 1 && names.length <= 1 ? named[0] : undefined;
  const cited = docs.filter(d => citedIds.has(d.note.id));
  if (priorCitation) return cited.length === 1 ? cited[0] : undefined;
  if (docs.length === 1) return docs[0];
  if (matched.size === 1) return [...matched][0];
}

export function editInstructions(target?: Document) {
  if (!target) return '尚未唯一确定要修改的笔记。请用户指定笔记或选择准确的来源。';
  return '用户请求修改笔记。目标为 ' + target.ref + '《' + target.note.title + '》。只提出建议，等用户在界面应用后才会写入。回复末尾使用一个 zhiwu-edit Markdown 代码块，内含 JSON ' +
    '{"source":"' + target.ref + '","operation":"replace","before":"正文中唯一的逐字原句","after":"新内容"}。' +
    '操作可选 replace（改正文）、append（新增独立摘录，before 为空）、rename（改标题，after 为新标题）。替换需逐字匹配可编辑正文，保留原件、附件与现有摘录。没有足够依据时先向用户确认。';
}

export function validatedEdit(reply: string, target: Document | undefined): TutorNoteEdit | undefined {
  const blocks = [...reply.matchAll(draftBlock)];
  if (blocks.length !== 1 || !target?.note.updated_at) return;
  try {
    const d = JSON.parse(blocks[0][1]);
    if (d?.source !== target.ref || !['replace', 'append', 'rename'].includes(d.operation) ||
        typeof d.after !== 'string' || d.after.length > maxText) return;
    const note = target.note;
    const p: TutorNoteEdit = { noteId: note.id, title: note.title, updatedAt: note.updated_at!,
      operation: d.operation, before: '', after: d.after };
    if (p.operation === 'replace') {
      if (typeof d.before !== 'string' || d.before.length > maxText || d.before === d.after ||
          (note.source_filename && note.source_type !== 'image' && note.source_content == null)) return;
      p.before = d.before;
      applyTutorBodyEdit(note.content, p);
    } else {
      p.after = p.after.trim();
      if (!p.after) return;
      if (p.operation === 'rename') {
        if (p.after === note.title || p.after.length > 200) return;
        p.before = note.title;
      }
    }
    return p;
  } catch { /* Only executable, unambiguous changes become proposals. */ }
}
