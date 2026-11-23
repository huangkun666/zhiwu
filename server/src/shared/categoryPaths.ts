type CategoryNode = { id: string; name: string; parent_id?: string | null };

export function categoryPaths(categories: readonly CategoryNode[]): Map<string, string[]> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const paths = new Map<string, string[]>();

  for (const category of byId.values()) {
    if (paths.has(category.id)) continue;

    const ancestors: CategoryNode[] = [];
    const positions = new Map<string, number>();
    let current: CategoryNode | undefined = category;
    let parentPath: string[] = [];

    while (current) {
      const cached = paths.get(current.id);
      if (cached) {
        parentPath = cached;
        break;
      }

      const cycleStart = positions.get(current.id);
      if (cycleStart !== undefined) {
        // An invalid backup can leave a cycle. Use each cycle member as a root.
        for (const member of ancestors.splice(cycleStart)) paths.set(member.id, [member.name]);
        parentPath = [current.name];
        break;
      }

      positions.set(current.id, ancestors.length);
      ancestors.push(current);
      current = current.parent_id == null ? undefined : byId.get(current.parent_id);
    }

    for (const ancestor of ancestors.reverse()) {
      parentPath = [...parentPath, ancestor.name];
      paths.set(ancestor.id, parentPath);
    }
  }

  return paths;
}
