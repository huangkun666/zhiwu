import { Router } from 'express';
import { db, existingCategoryId, inTransaction, nowIso, reconcileLibraryReferences, uid } from '../db.js';
import { nextNoteUpdatedAt } from '../shared/noteContent.js';
import { categoryPaths } from '../shared/categoryPaths.js';

export const categoriesRouter = Router();

type CategoryRow = { id: string; name: string; parent_id: string | null };

categoriesRouter.get('/', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, COUNT(n.id) as note_count
       FROM categories c
       LEFT JOIN active_notes n ON n.category_id = c.id
       GROUP BY c.id
       ORDER BY c.created_at ASC`
    )
    .all() as unknown as CategoryRow[];
  const paths = categoryPaths(rows);
  res.json(rows.map((row) => ({ ...row, path: paths.get(row.id) })));
});

function insertCategory(name: string, parent: string | null, { color = '#3B5BDB', icon = 'folder', description = '' } = {}) {
  const id = uid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO categories (id, name, parent_id, color, icon, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, parent, color, icon, description, now, now);
  return id;
}

function ensureCategoryPath(path: string[], parentId: unknown) {
  return inTransaction(() => {
    let parent = existingCategoryId(parentId);
    if (parentId != null && !parent) return { status: 400, data: { error: '上级分类不存在' } };

    const prefix = parent
      ? categoryPaths(db.prepare(`SELECT id, name, parent_id FROM categories`).all() as unknown as CategoryRow[]).get(parent) ?? []
      : [];
    const fullPath = [...prefix, ...path];
    const existing = db.prepare(`SELECT id FROM categories WHERE name = ? AND parent_id IS ? LIMIT 2`);
    for (let i = 0; i < path.length; i++) {
      const matches = existing.all(path[i], parent) as { id: string }[];
      if (matches.length > 1) {
        const ambiguousPath = fullPath.slice(0, prefix.length + i + 1).join(' / ');
        return { status: 409, data: { error: `有多个同名分类「${ambiguousPath}」，请确认要使用的分类编号` } };
      }
      if (matches.length === 0) {
        for (const name of path.slice(i)) parent = insertCategory(name, parent);
        return { status: 201, data: { id: parent, path: fullPath } };
      }
      parent = matches[0].id;
    }
    return { status: 200, data: { id: parent, path: fullPath } };
  });
}

categoriesRouter.post('/', (req, res) => {
  const { name, color, icon, description, parentId, path } = req.body || {};
  if (path !== undefined) {
    if (!Array.isArray(path) || path.length === 0 || path.some((name) => typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: '分类路径需要按顺序填写每一级的名称' });
    }
    const result = ensureCategoryPath(path.map((name: string) => name.trim()), parentId);
    return res.status(result.status).json(result.data);
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: '分类名称不能为空' });
  }
  const parent = existingCategoryId(parentId);
  if (parentId && !parent) return res.status(400).json({ error: '上级分类不存在' });
  const id = insertCategory(String(name).trim(), parent, { color, icon, description });
  const created = db.prepare(`SELECT *, 0 as note_count FROM categories WHERE id = ?`).get(id);
  res.status(201).json(created);
});

categoriesRouter.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, color, icon, description } = req.body || {};
  const existing = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id) as any;
  if (!existing) return res.status(404).json({ error: '分类不存在' });

  db.prepare(
    `UPDATE categories SET name = ?, color = ?, icon = ?, description = ?, updated_at = ? WHERE id = ?`
  ).run(
    name?.trim() || existing.name,
    color || existing.color,
    icon || existing.icon,
    description ?? existing.description,
    nextNoteUpdatedAt(existing.updated_at ?? existing.created_at),
    id
  );
  res.json(db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id));
});

categoriesRouter.delete('/:id', (req, res) => {
  const { id } = req.params;
  inTransaction(() => {
    db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
    reconcileLibraryReferences();
  });
  res.json({ ok: true });
});
