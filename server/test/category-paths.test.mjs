import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryPaths } from '../src/shared/categoryPaths.ts';

test('category paths distinguish equal leaf names in different branches', () => {
  const paths = categoryPaths([
    { id: 'review', name: '复习', parent_id: 'algorithms' },
    { id: 'algorithms', name: '算法', parent_id: 'cs' },
    { id: 'cs', name: '计算机', parent_id: null },
    { id: 'work-review', name: '复习', parent_id: 'work' },
    { id: 'work', name: '工作' },
  ]);
  assert.deepEqual(paths.get('review'), ['计算机', '算法', '复习']);
  assert.deepEqual(paths.get('work-review'), ['工作', '复习']);
});

test('category paths start at the first available ancestor when a parent is missing', () => {
  const paths = categoryPaths([
    { id: 'child', name: '子分类', parent_id: 'legacy' },
    { id: 'legacy', name: '旧分类', parent_id: 'missing' },
  ]);
  assert.deepEqual(paths.get('legacy'), ['旧分类']);
  assert.deepEqual(paths.get('child'), ['旧分类', '子分类']);
});

test('category paths break cycles and keep valid descendants', () => {
  const paths = categoryPaths([
    { id: 'child', name: '子分类', parent_id: 'a' },
    { id: 'b', name: '乙', parent_id: 'a' },
    { id: 'a', name: '甲', parent_id: 'b' },
    { id: 'self', name: '旧分类', parent_id: 'self' },
  ]);
  assert.deepEqual(paths.get('child'), ['甲', '子分类']);
  assert.deepEqual(paths.get('a'), ['甲']);
  assert.deepEqual(paths.get('b'), ['乙']);
  assert.deepEqual(paths.get('self'), ['旧分类']);
});
