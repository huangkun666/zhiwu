export interface StudyConcept {
  id: string;
  name: string;
  mastery_score: number;
  quiz_attempts: number;
  quiz_correct: number;
}

export interface TodayProgress {
  reviewedCards: number;
  reviewedMistakes: number;
  quizzesCompleted: number;
  nextReviewAt: string | null;
}

export interface MasteryChange {
  id: string;
  name: string;
  before: number | null;
  after: number;
}

export function isWeakConcept(concept: StudyConcept): boolean {
  return concept.quiz_attempts > 0 && concept.quiz_correct < concept.quiz_attempts && concept.mastery_score < 0.75;
}

export function rankWeakConcepts<T extends StudyConcept>(concepts: readonly T[]): T[] {
  return concepts.filter(isWeakConcept).sort((a, b) =>
    a.mastery_score - b.mastery_score || b.quiz_attempts - a.quiz_attempts || a.id.localeCompare(b.id));
}

export function splitStudyConcepts(concepts: readonly StudyConcept[]) {
  const untested = concepts.filter(({ quiz_attempts }) => !quiz_attempts)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    weakConcepts: rankWeakConcepts(concepts).slice(0, 5).map(({ id, name, mastery_score, quiz_attempts, quiz_correct }) => ({
      id, name, mastery_score, quiz_attempts, quiz_correct,
    })),
    untestedConcepts: untested.slice(0, 3).map(({ id, name }) => ({ id, name })),
    untestedCount: untested.length,
  };
}

export function recordMasteryChange(changes: Map<string, MasteryChange>, update?: MasteryChange) {
  if (!update) return;
  const previous = changes.get(update.id);
  changes.set(update.id, previous ? { ...update, before: previous.before } : update);
}
