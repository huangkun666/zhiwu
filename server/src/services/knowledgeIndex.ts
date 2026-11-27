import { db } from '../db.js';
import { AIConfigError, callLLM, getActiveProvider } from './ai.js';
import { canAdvanceKnowledge, createKnowledgeQueue, startKnowledgeIndex } from '../shared/knowledgePoints.js';
import type { TutorSource } from '../shared/tutorSources.js';

export function readKnowledgeNote(id: string) {
  return db.prepare('SELECT * FROM active_notes WHERE id = ?').get(id) as TutorSource | undefined;
}

function setIndex(id: string, index: unknown) {
  db.prepare('UPDATE notes SET knowledge_index = ? WHERE id = ? AND deleted_at IS NULL').run(JSON.stringify(index), id);
}

export function initializeNoteKnowledge(id: string) {
  const note = readKnowledgeNote(id);
  if (!note) return;
  const index = startKnowledgeIndex(note);
  setIndex(id, index);
  return { ...note, knowledge_index: index };
}

export const scheduleKnowledge = createKnowledgeQueue({
  load: readKnowledgeNote,
  save(id, before, after) {
    const note = readKnowledgeNote(id);
    if (!note || !canAdvanceKnowledge(note, before)) return false;
    setIndex(id, after);
    return true;
  },
  async model(messages, signal) {
    try {
      return await callLLM(messages, { provider: getActiveProvider(), jsonMode: true, temperature: 0, maxTokens: 2400, signal });
    } catch (error) {
      if (error instanceof AIConfigError) return null;
      throw error;
    }
  },
});

export function resumeNoteKnowledge() {
  const pending = db.prepare(`SELECT id FROM active_notes WHERE
    CASE WHEN json_valid(knowledge_index) THEN json_extract(knowledge_index, '$.status') END = 'pending'`).all() as { id: string }[];
  scheduleKnowledge(pending.map(({ id }) => id));
}
