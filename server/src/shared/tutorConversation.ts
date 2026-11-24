import { tutorOpeningMode, type TutorMode } from './tutorMode.js';
import { isNoteEditRequest } from './tutorNoteEdit.js';
import { cleanHistory, lastScan, stripTutorMetadata, type TutorMessage } from './tutorScan.js';

const searchMarker = '[[SEARCH_NOTES]]';
const directPrompt = '你是知悟的对话助手。结合当前对话，直接回答用户的问题。问题需要说明时，给出清楚的解释或例子。';
const searchOption = '你可以调用本机笔记检索。日常知识或已有聊天足以回答时直接作答。如果答案取决于用户保存、上传或先前引用的资料，或某个产品、版本、条款的具体规定，需要读原文时只返回一行 ' + searchMarker + '，应用会检索并把可核对的原文交给你。';

export function recentHistory(history: TutorMessage[], general = false) {
  const recent: TutorMessage[] = [];
  let remaining = 10000;
  for (const message of history.slice(-12).reverse()) {
    if (remaining < 200) break;
    if ((message.role !== 'assistant' && message.role !== 'user') || typeof message.content !== 'string') continue;
    if (general && message.role === 'assistant' && tutorOpeningMode(message.content)) continue;
    const text = general && message.role === 'assistant' ? stripTutorMetadata(message.content) : cleanHistory(message.content);
    const limit = Math.min(remaining, 3200);
    const content = text.length <= limit ? text : text.slice(0, limit / 2 - 3) + '\n[…]\n' + text.slice(-limit / 2 + 3);
    recent.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return recent;
}

export function generalTutorTurn(history: TutorMessage[], question: string, offerSearch = false) {
  const messages: TutorMessage[] = [
    { role: 'system', content: offerSearch ? directPrompt + searchOption : directPrompt },
    ...recentHistory(history, true),
    { role: 'user', content: question },
  ];
  return { messages, render: stripTutorMetadata };
}

export function citedReply(history: TutorMessage[]) {
  return history.slice(-12).reverse().find(m => m.role === 'assistant' && /\]\(\?note=/.test(m.content))?.content;
}

export function relativeSourcePosition(question: string) {
  const match = question.match(/([下后前上])一?(?:个|一)?(?:自然)?(页|段)|\b(next|following|previous|preceding)\s+(page|paragraph)\b/i);
  if (!match) return;
  const next = match[1] ? /[下后]/.test(match[1]) : /next|following/i.test(match[3]);
  return { offset: next ? 1 : -1, page: match[2] === '页' || match[4]?.toLowerCase() === 'page' };
}

const noteWord = /笔记(?!本电脑)|资料|文档|原文|附件|文件|PDF/i;

function skipsLibrary(question: string) {
  if (/(?:只|仅)(?:按|用|凭|根据)(?:常识|通用知识|一般知识)|\b(?:general knowledge only|only (?:use |from )?general knowledge)\b/i.test(question)) return true;
  return question.split(/[，,。！？!?;；\n]/).some(clause => {
    const chinese = clause.match(/(?:别|不要|不用|不必|无需|不需要|禁止)\s*(?:帮我|再|先|去)*(.{0,48})/);
    if (chinese) {
      const instruction = chinese[1].trim();
      const action = /^(?:查|检索|搜|参考|使用|翻|看|读|用|依据|根据|结合)/;
      if (noteWord.test(instruction) && (action.test(instruction) ||
        /^(?:在|从).{0,20}(?:查|找|搜|读)/.test(instruction))) return true;
      if (/^(?:检索|搜索|查找|查询|查)(?:了|一下)?$/.test(instruction)) return true;
    }
    const english = clause.match(/\b(?:do not|don['’]t|no need to|without|skip|avoid|never)\s+(.{0,75})/i);
    return !!english && /\b(?:notes?|notebooks?|files?|documents?|pdfs?|library)\b/i.test(english[1]) &&
      /^(?:consult|search|check|read|us[ei]|look|refer|access|(?:the |my |our )?(?:notes?|files?|documents?|library)\b)/i.test(english[1]);
  });
}

export function generalTutorIntent(history: TutorMessage[], question: string): 'direct' | 'search' | 'auto' {
  if (skipsLibrary(question) || question.includes(searchMarker)) return 'direct';
  const cited = citedReply(history);
  if (lastScan(history, question) || isNoteEditRequest(question, !!cited)) return 'search';
  const explicitSource = /笔记库|我(?:的|上传的?|导入的?|保存的?|记的).{0,4}(?:笔记(?!本电脑)|文档|资料|PDF|附件)|(?:这|那)(?:份|篇|本)(?:笔记|资料|文档|PDF)/i;
  const readSource = /(?:笔记(?!本电脑)|资料|原文|文档|附件|PDF)\s*(?:里|中|上说|第\s*\d+\s*页)|(?:查|翻|读回|核对|参考|根据|结合|检索|搜)[^，。！？!?\n]{0,12}(?:笔记(?!本电脑)|资料|原文|文档|PDF|附件)|(?:提供|引用|对照)(?:一下)?(?:出处|原文)/i;
  const englishSource = /\b(?:my|our|this|that|the attached|the uploaded|the saved)\s+(?:(?:saved|uploaded|attached|local)\s+)?(?:notes?|notebooks?|documents?|pdfs?|files?|library)\b/i;
  if (explicitSource.test(question) || readSource.test(question) || englishSource.test(question)) return 'search';
  const followup = /第\s*[\d一二三四五六七八九十]+\s*[页段]|(?:刚才|上[条次一轮]|那条|这个).{0,7}(?:引用|出处|原文)|\b(?:the citation|cited (?:page|source)|page \d+)\b/i;
  if (cited && (relativeSourcePosition(question) || followup.test(question))) return 'search';
  return 'auto';
}

// A text control line works with the app's JSON, SSE and Gemini providers.
// Hold only the possible leading control line; prose can stream immediately.
export function generalTutorReply(onDelta?: (delta: string) => void) {
  let pending = '';
  let state: 'undecided' | 'answer' | 'search' = 'undecided';
  const isRequest = (reply: string) => reply.trimStart().split(/\r?\n/, 1)[0].trimEnd() === searchMarker;
  return {
    push(delta: string) {
      if (!onDelta || state === 'search') return;
      if (state === 'answer') { onDelta(delta); return; }
      pending += delta;
      const start = pending.trimStart();
      if (searchMarker.startsWith(start)) return;
      if (isRequest(pending)) {
        if (start.includes('\n')) { state = 'search'; pending = ''; }
        return;
      }
      state = 'answer';
      onDelta(pending);
      pending = '';
    },
    finish(response: string) {
      if (isRequest(response)) return { search: true, answer: '' };
      if (pending) onDelta?.(pending);
      return { search: false, answer: stripTutorMetadata(response) };
    },
  };
}

export async function runTutorChat<T extends { messages: TutorMessage[]; scanFallback?: string }>(
  mode: TutorMode, history: TutorMessage[], question: string,
  answer: (messages: TutorMessage[], onDelta?: (delta: string) => void) => Promise<string>,
  readNotes: () => Promise<T>, onDelta?: (delta: string) => void,
): Promise<{ reply: string; sources?: T }> {
  if (mode === 'general') {
    const intent = generalTutorIntent(history, question);
    if (intent !== 'search') {
      const turn = generalTutorTurn(history, question, intent === 'auto');
      if (intent === 'direct') return { reply: turn.render(await answer(turn.messages, onDelta)) };
      const gate = generalTutorReply(onDelta);
      const result = gate.finish(await answer(turn.messages, onDelta ? gate.push : undefined));
      if (!result.search) return { reply: result.answer };
    }
  }
  const sources = await readNotes();
  // Only the validated preview belongs in the chat UI. Its generated JSON stays private to this turn.
  const showDelta = isNoteEditRequest(question, !!citedReply(history)) ? undefined : onDelta;
  try {
    const reply = await answer(sources.messages, showDelta);
    return { reply: reply.trim() ? reply : sources.scanFallback ?? reply, sources };
  } catch (error) {
    if (!sources.scanFallback) throw error;
    return { reply: sources.scanFallback, sources };
  }
}
