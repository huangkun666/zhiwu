import { Router } from 'express';
import { db } from '../db.js';
import { buildGraphLinks } from '../shared/graphLinks.js';

export const graphRouter = Router();

graphRouter.get('/', (_req, res) => {
  const concepts = db
    .prepare(
      `SELECT c.id, c.name, c.description, c.mastery_score, c.quiz_attempts, c.quiz_correct, c.created_at,
        cat.id as category_id, cat.name as category_name, cat.color as category_color,
        (SELECT COUNT(*) FROM note_concepts nc INNER JOIN notes n ON n.id = nc.note_id WHERE nc.concept_id = c.id) as note_count,
        (SELECT COUNT(*) FROM mistakes m WHERE m.concept_name = c.name AND m.status != 'mastered') as active_mistakes
       FROM active_concepts c
       LEFT JOIN categories cat ON cat.id = (
         SELECT n.category_id FROM note_concepts nc INNER JOIN notes n ON n.id = nc.note_id
         WHERE nc.concept_id = c.id AND n.category_id IS NOT NULL
         ORDER BY (n.category_id = c.category_id) DESC, n.updated_at DESC, n.id LIMIT 1
       )
       ORDER BY note_count DESC, c.created_at DESC`
    )
    .all() as any[];

  // Also map each concept to its linked notes so clicking a node opens related notes
  const noteMappings = db
    .prepare(
      `SELECT c.id AS concept_id, c.name AS concept_name, n.id AS note_id, n.title, n.summary_json
       FROM note_concepts nc
       INNER JOIN notes n ON n.id = nc.note_id
       INNER JOIN concepts c ON c.id = nc.concept_id
       ORDER BY n.updated_at DESC, n.id, c.id`
    )
    .all() as { concept_id: string; concept_name: string; note_id: string; title: string; summary_json: string | null }[];

  const notesByConcept = new Map<string, { id: string; title: string }[]>();
  const conceptsByNote = new Map<string, { summary: unknown; concepts: { id: string; name: string }[] }>();
  for (const m of noteMappings) {
    const notes = notesByConcept.get(m.concept_id) || [];
    notes.push({ id: m.note_id, title: m.title });
    notesByConcept.set(m.concept_id, notes);
    const note = conceptsByNote.get(m.note_id) || { summary: m.summary_json, concepts: [] };
    note.concepts.push({ id: m.concept_id, name: m.concept_name });
    conceptsByNote.set(m.note_id, note);
  }

  const nodes = concepts.map((c) => ({
    ...c,
    notes: notesByConcept.get(c.id) || [],
  }));

  // Weak concepts diagnosis: sorted by mastery ascending and active mistakes descending
  const weakConcepts = [...nodes]
    .sort((a, b) => a.mastery_score - b.mastery_score || b.active_mistakes - a.active_mistakes)
    .slice(0, 12);

  res.json({
    nodes,
    links: buildGraphLinks(conceptsByNote.values()),
    weakConcepts,
  });
});
