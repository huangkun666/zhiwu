interface ConceptNode {
  id: string;
  name: string;
}

interface Link {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
}

function summaryRelations(summary: unknown): { source: string; target: string; relation?: string }[] {
  if (typeof summary === 'string') {
    try {
      summary = JSON.parse(summary);
    } catch {
      return [];
    }
  }
  const relations = (summary as { relations?: unknown } | null)?.relations;
  if (!Array.isArray(relations)) return [];
  return relations.filter((item) => typeof item?.source === 'string' && typeof item.target === 'string');
}

function pairKey(source: string, target: string): string {
  return JSON.stringify(source < target ? [source, target] : [target, source]);
}

export function buildGraphLinks(notes: Iterable<{ concepts: ConceptNode[]; summary: unknown }>): Link[] {
  const explicit = new Map<string, Link>();
  const cooccurring = new Map<string, Link>();
  const linkedPairs = new Set<string>();
  for (const { concepts, summary } of notes) {
    const namedIds = new Map(concepts.map(({ id, name }) => [name, id]));
    for (const link of summaryRelations(summary)) {
      const source = namedIds.get(link.source.trim());
      const target = namedIds.get(link.target.trim());
      if (!source || !target || source === target) continue;
      const id = `rel-${JSON.stringify([source, target])}`;
      if (!explicit.has(id)) {
        const relation = typeof link.relation === 'string' ? link.relation.trim() : '';
        explicit.set(id, { id, source, target, relation: relation || '相关', weight: 1 });
      }
      linkedPairs.add(pairKey(source, target));
    }

    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        const source = concepts[i].id;
        const target = concepts[j].id;
        const key = pairKey(source, target);
        if (source !== target && !cooccurring.has(key)) {
          cooccurring.set(key, { id: `co-${key}`, source, target, relation: '同篇共现', weight: 0.6 });
        }
      }
    }
  }
  for (const pair of linkedPairs) cooccurring.delete(pair);
  return [...explicit.values(), ...cooccurring.values()];
}
