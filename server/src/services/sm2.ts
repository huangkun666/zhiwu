// SM-2 Spaced Repetition Algorithm
// Ratings: 1 = Again (重来), 2 = Hard (困难), 3 = Good (良好), 4 = Easy (简单)

export interface SM2State {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
}

export interface SM2Result extends SM2State {
  nextReviewAt: string;
  label: string;
}

export function computeSM2(state: SM2State, rating: 1 | 2 | 3 | 4, now = new Date()): SM2Result {
  let { easeFactor, intervalDays, repetitions } = state;
  easeFactor = Math.max(1.3, easeFactor || 2.5);
  intervalDays = Math.max(0, intervalDays || 0);
  repetitions = Math.max(0, repetitions || 0);

  let nextMs: number;
  let label: string;

  if (rating === 1) {
    // Again: reset streak, review again in 10 minutes (or next session)
    repetitions = 0;
    intervalDays = 0;
    easeFactor = Math.max(1.3, easeFactor - 0.2);
    nextMs = now.getTime() + 10 * 60 * 1000;
    label = '10分钟后';
  } else if (rating === 2) {
    // Hard
    if (repetitions === 0) {
      intervalDays = 1;
    } else {
      intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
    }
    repetitions += 1;
    easeFactor = Math.max(1.3, easeFactor - 0.15);
    nextMs = now.getTime() + intervalDays * 24 * 60 * 60 * 1000;
    label = `${intervalDays}天后`;
  } else if (rating === 3) {
    // Good
    if (repetitions === 0) {
      intervalDays = 1;
    } else if (repetitions === 1) {
      intervalDays = 4;
    } else {
      intervalDays = Math.max(1, Math.round(intervalDays * easeFactor));
    }
    repetitions += 1;
    nextMs = now.getTime() + intervalDays * 24 * 60 * 60 * 1000;
    label = `${intervalDays}天后`;
  } else {
    // Easy (rating === 4)
    if (repetitions === 0) {
      intervalDays = 4;
    } else if (repetitions === 1) {
      intervalDays = 7;
    } else {
      intervalDays = Math.max(2, Math.round(intervalDays * easeFactor * 1.3));
    }
    repetitions += 1;
    easeFactor = Math.min(3.2, easeFactor + 0.15);
    nextMs = now.getTime() + intervalDays * 24 * 60 * 60 * 1000;
    label = `${intervalDays}天后`;
  }

  return {
    easeFactor: Number(easeFactor.toFixed(2)),
    intervalDays,
    repetitions,
    nextReviewAt: new Date(nextMs).toISOString(),
    label,
  };
}

export function previewSM2Intervals(state: SM2State) {
  return {
    1: computeSM2(state, 1).label,
    2: computeSM2(state, 2).label,
    3: computeSM2(state, 3).label,
    4: computeSM2(state, 4).label,
  };
}
