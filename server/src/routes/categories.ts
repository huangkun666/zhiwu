import { Router } from 'express';
import { db, existingCategoryId, inTransaction, nowIso, reconcileLibraryReferences, uid } from '../db.js';

export const categoriesRouter = Router();

categoriesRouter.get('/', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, COUNT(n.id) as note_count
       FROM categories c
       LEFT JOIN notes n ON n.category_id = c.id
       GROUP BY c.id
       ORDER BY c.created_at ASC`
    )
    .all();
  res.json(rows);
});

categoriesRouter.post('/', (req, res) => {
  const { name, color = '#3B5BDB', icon = 'folder', description = '', parentId = null } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: '分类名称不能为空' });
  }
  const parent = existingCategoryId(parentId);
  if (parentId && !parent) return res.status(400).json({ error: '上级分类不存在' });
  const id = uid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO categories (id, name, parent_id, color, icon, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, String(name).trim(), parent, color, icon, description, now);
  const created = db.prepare(`SELECT *, 0 as note_count FROM categories WHERE id = ?`).get(id);
  res.status(201).json(created);
});

categoriesRouter.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, color, icon, description } = req.body || {};
  const existing = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id) as any;
  if (!existing) return res.status(404).json({ error: '分类不存在' });

  db.prepare(
    `UPDATE categories SET name = ?, color = ?, icon = ?, description = ? WHERE id = ?`
  ).run(
    name?.trim() || existing.name,
    color || existing.color,
    icon || existing.icon,
    description ?? existing.description,
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
