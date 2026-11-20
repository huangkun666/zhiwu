import { Router } from 'express';
import { db } from '../db.js';

export const graphRouter = Router();

graphRouter.get('/', (_req, res) => {
  const concepts = db
    .prepare(
      `SELECT c.*, cat.name as category_name, cat.color as category_color,
        (SELECT COUNT(*) FROM note_concepts nc WHERE nc.concept_id = c.id) as note_count,
        (SELECT COUNT(*) FROM mistakes m WHERE m.concept_name = c.name AND m.status != 'mastered') as active_mistakes
       FROM concepts c
       LEFT JOIN categories cat ON c.category_id = cat.id
       ORDER BY note_count DESC, c.created_at DESC`
    )
    .all() as any[];

  const links = db
    .prepare(
      `SELECT cl.id, cl.source_id as source, cl.target_id as target, cl.relation, cl.weight
       FROM concept_links cl`
    )
    .all() as any[];

  // Also map each concept to its linked notes so clicking a node opens related notes
  const noteMappings = db
    .prepare(
      `SELECT nc.concept_id, n.id as note_id, n.title
       FROM note_concepts nc
       INNER JOIN notes n ON n.id = nc.note_id`
    )
    .all() as { concept_id: string; note_id: string; title: string }[];

  const notesByConcept: Record<string, { id: string; title: string }[]> = {};
  for (const m of noteMappings) {
    if (!notesByConcept[m.concept_id]) notesByConcept[m.concept_id] = [];
    notesByConcept[m.concept_id].push({ id: m.note_id, title: m.title });
  }

  // Add implicit co-occurrence links for concepts sharing the same note if no explicit link exists
  const pairSet = new Set(links.map((l) => `${l.source}::${l.target}`));
  const conceptsByNote: Record<string, string[]> = {};
  for (const m of noteMappings) {
    if (!conceptsByNote[m.note_id]) conceptsByNote[m.note_id] = [];
    conceptsByNote[m.note_id].push(m.concept_id);
  }
  const implicitLinks: any[] = [];
  for (const cids of Object.values(conceptsByNote)) {
    for (let i = 0; i < cids.length; i++) {
      for (let j = i + 1; j < cids.length; j++) {
        const key1 = `${cids[i]}::${cids[j]}`;
        const key2 = `${cids[j]}::${cids[i]}`;
        if (!pairSet.has(key1) && !pairSet.has(key2)) {
          pairSet.add(key1);
          implicitLinks.push({
            id: `co-${cids[i]}-${cids[j]}`,
            source: cids[i],
            target: cids[j],
            relation: '同篇共现',
            weight: 0.6,
          });
        }
      }
    }
  }

  const nodes = concepts.map((c) => ({
    ...c,
    notes: notesByConcept[c.id] || [],
  }));

  // Weak concepts diagnosis: sorted by mastery ascending and active mistakes descending
  const weakConcepts = [...nodes]
    .sort((a, b) => a.mastery_score - b.mastery_score || b.active_mistakes - a.active_mistakes)
    .slice(0, 12);

  res.json({
    nodes,
    links: [...links, ...implicitLinks],
    weakConcepts,
  });
});
