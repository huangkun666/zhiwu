export type TutorMode = 'general' | 'qa' | 'feynman';

export const tutorModeLabels: Record<TutorMode, string> = {
  general: '普通对话', qa: '深度答疑', feynman: '费曼考官',
};

export const tutorDefaultTitles: Record<TutorMode, string> = {
  general: '普通对话', qa: '笔记深度答疑', feynman: '费曼考官演练',
};

const openingPrefixes = {
  qa: ['你好！我是你的**知悟学习助教**。我已经准备好结合你的笔记', '你好！我是你的**知悟学习助教**，随时基于你的笔记'],
  feynman: ['你好！我是你的**费曼学习法考官**。\n\n请选择一个概念，试着用', '你好！我是你的**费曼学习法考官**。试着用大白话把一个概念'],
};

export function tutorOpeningMode(content: string): 'qa' | 'feynman' | undefined {
  for (const mode of ['qa', 'feynman'] as const) {
    if (openingPrefixes[mode].some(prefix => content.startsWith(prefix))) return mode;
  }
}

export function isTutorMode(value: unknown): value is TutorMode {
  return value === 'general' || value === 'qa' || value === 'feynman';
}

export function requireTutorMode(value: unknown): TutorMode {
  if (!isTutorMode(value)) throw new Error('会话模式无效');
  return value;
}

export function newTutorMode(mode: unknown, noteIds: unknown): TutorMode {
  if (mode !== undefined) return requireTutorMode(mode);
  // Older clients created note-based sessions by sending only the reference picker.
  return noteIds === undefined ? 'general' : 'qa';
}
