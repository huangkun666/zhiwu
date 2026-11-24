export function readIds(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

export function existingIds(value: unknown, available: ReadonlySet<string>): string[] {
  return readIds(value).filter((id) => available.has(id));
}

export function tutorNoteSelection(stored: unknown, visible: string[], selected: string[], discard: unknown = []) {
  const unchanged = selected.length === visible.length && selected.every((id, index) => id === visible[index]);
  const visibleIds = new Set(visible);
  const hiddenIds = new Set(readIds(stored).filter((id) => !visibleIds.has(id)));
  const removed = new Set(readIds(discard).filter(id => hiddenIds.has(id)));
  return (latest: unknown) => {
    const current = readIds(latest);
    const saved = unchanged ? current : [...current.filter((id) => hiddenIds.has(id)), ...selected];
    return saved.filter(id => !removed.has(id));
  };
}

export function questionSourceId(value: unknown, sources: readonly string[]): string | null {
  if (typeof value === 'string' && sources.includes(value)) return value;
  return sources.length === 1 ? sources[0] : null;
}
