import { useEffect, useState } from 'react';
import {
  BookmarkPlus,
  CheckCircle2,
  Clock,
  FileCheck2,
  Loader2,
  MessageSquareText,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../api/client';
import type { Category, Note, PageId, PracticeContext, Quiz } from '../types';

interface QuizPageProps {
  categories: Category[];
  categoryLabels: ReadonlyMap<string, string>;
  initialContext?: PracticeContext | null;
  onRefreshGlobal: () => void;
  onNavigate: (page: PageId, context?: any) => void;
}

const QUESTION_TYPES = [
  { id: 'single', label: '单选' },
  { id: 'multiple', label: '多选' },
  { id: 'boolean', label: '判断' },
  { id: 'short', label: '简答 (AI批改)' },
] as const;

export function QuizPage({ categories, categoryLabels, initialContext, onRefreshGlobal, onNavigate }: QuizPageProps) {
  const [view, setView] = useState<'setup' | 'taking' | 'result'>('setup');
  const [notes, setNotes] = useState<Note[]>([]);
  const [history, setHistory] = useState<Quiz[]>([]);

  const [sourceMode, setSourceMode] = useState<'notes' | 'category' | 'weak'>('notes');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [selectedCatId, setSelectedCatId] = useState<string>('');
  const [focusConcepts, setFocusConcepts] = useState<string[]>([]);
  const [count, setCount] = useState(initialContext?.count ?? 5);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [selectedTypes, setSelectedTypes] = useState<('single' | 'multiple' | 'boolean' | 'short')[]>([
    'single',
    'boolean',
    'short',
  ]);

  const [activeQuiz, setActiveQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bookmarked, setBookmarked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const availableNoteIds = selectedNoteIds.filter((id) => notes.some((note) => note.id === id));
  const hasSource = sourceMode === 'notes'
    ? availableNoteIds.length > 0
    : notes.some((note) => sourceMode !== 'category' || !selectedCatId || note.category_id === selectedCatId);

  const loadInit = async () => {
    const [noteList, quizList] = await Promise.all([api.getNotes(), api.getQuizzes()]);
    setNotes(noteList);
    setHistory(quizList);
    if (noteList.length > 0 && selectedNoteIds.length === 0 && !initialContext?.noteIds) {
      setSelectedNoteIds([noteList[0].id]);
    }
  };

  useEffect(() => {
    loadInit();
  }, []);

  useEffect(() => {
    if (!initialContext) return;
    if (initialContext.count) setCount(initialContext.count);
    if (initialContext.weakOnly) {
      setSourceMode('weak');
      setFocusConcepts(initialContext.focusConcepts || []);
      setView('setup');
    } else if (initialContext.noteIds?.length) {
      setSourceMode('notes');
      setSelectedNoteIds(initialContext.noteIds);
      setView('setup');
    }
  }, [initialContext]);

  const toggleType = (t: 'single' | 'multiple' | 'boolean' | 'short') => {
    setSelectedTypes((prev) =>
      prev.includes(t) ? (prev.length > 1 ? prev.filter((x) => x !== t) : prev) : [...prev, t]
    );
  };

  const handleGenerate = async () => {
    if (!hasSource) return;
    setError('');
    setGenerating(true);
    try {
      const quiz = await api.generateQuiz({
        noteIds: sourceMode === 'notes' ? availableNoteIds : [],
        categoryId: sourceMode === 'category' ? selectedCatId || null : null,
        weakOnly: sourceMode === 'weak',
        focusConcepts: sourceMode === 'weak' ? focusConcepts : [],
        count,
        difficulty,
        types: selectedTypes,
      });
      setActiveQuiz(quiz);
      setAnswers({});
      setView('taking');
      loadInit();
    } catch (e: any) {
      setError(e.message || '动态出题失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!activeQuiz) return;
    setSubmitting(true);
    setError('');
    try {
      const graded = await api.submitQuiz(activeQuiz.id, answers);
      setActiveQuiz(graded);
      setView('result');
      onRefreshGlobal();
      loadInit();
    } catch (e: any) {
      setError(e.message || '交卷批改失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openQuiz = async (id: string) => {
    const q = await api.getQuiz(id);
    setActiveQuiz(q);
    if (q.status === 'completed') setView('result');
    else {
      setAnswers({});
      setView('taking');
    }
  };

  const toggleMultipleOption = (qid: string, letter: string) => {
    const cur = (answers[qid] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const next = cur.includes(letter) ? cur.filter((x) => x !== letter) : [...cur, letter].sort();
    setAnswers((prev) => ({ ...prev, [qid]: next.join(',') }));
  };

  if (view === 'taking' && activeQuiz?.questions) {
    const answeredCount = activeQuiz.questions.filter((q) => (answers[q.id] || '').trim() !== '').length;
    return (
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 rounded-2xl zw-card sticky top-14 md:top-4 z-20">
          <div>
            <h2 className="font-semibold text-sm">{activeQuiz.title}</h2>
            <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
              已答 {answeredCount} / {activeQuiz.questions.length}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setView('setup')} className="px-3 py-1.5 rounded-xl zw-btn-secondary text-xs cursor-pointer">
              返回
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl zw-btn-primary text-xs font-semibold disabled:opacity-50 cursor-pointer"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileCheck2 className="w-3.5 h-3.5" />}
              {submitting ? '批改中...' : '交卷'}
            </button>
          </div>
        </div>

        {error && (
          <div
            className="p-3 rounded-xl border text-xs"
            style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)', color: 'var(--danger-fg)' }}
          >
            {error}
          </div>
        )}

        <div className="space-y-4">
          {activeQuiz.questions.map((q, idx) => (
            <div key={q.id} className="p-5 rounded-2xl zw-card space-y-3.5">
              <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                <span className="font-medium text-[var(--text-secondary)]">
                  第 {idx + 1} 题 ·{' '}
                  {q.type === 'single' ? '单选' : q.type === 'multiple' ? '多选' : q.type === 'boolean' ? '判断' : '简答'}
                </span>
                {q.concept_name && <span>{q.concept_name}</span>}
              </div>

              <p className="text-sm sm:text-[15px] font-medium leading-relaxed">{q.stem}</p>

              {(q.type === 'single' || q.type === 'multiple') && (
                <div className="space-y-2">
                  {q.options.map((opt, i) => {
                    const letter = opt.match(/^([A-D])[.、\s]/i)?.[1]?.toUpperCase() || String.fromCharCode(65 + i);
                    const selected =
                      q.type === 'single'
                        ? answers[q.id] === letter
                        : (answers[q.id] || '').split(',').includes(letter);
                    return (
                      <button
                        key={i}
                        onClick={() =>
                          q.type === 'single'
                            ? setAnswers((p) => ({ ...p, [q.id]: letter }))
                            : toggleMultipleOption(q.id, letter)
                        }
                        className="w-full text-left px-4 py-3 rounded-xl border text-sm transition cursor-pointer"
                        style={{
                          background: selected ? 'var(--bg-active)' : 'var(--bg-subtle)',
                          borderColor: selected ? 'var(--border-strong)' : 'var(--border-hairline)',
                          fontWeight: selected ? 600 : 400,
                        }}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === 'boolean' && (
                <div className="grid grid-cols-2 gap-3">
                  {['对', '错'].map((val) => {
                    const selected = answers[q.id] === val;
                    return (
                      <button
                        key={val}
                        onClick={() => setAnswers((p) => ({ ...p, [q.id]: val }))}
                        className="py-3 rounded-xl border text-xs font-semibold transition cursor-pointer"
                        style={{
                          background: selected ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                          color: selected ? 'var(--btn-primary-fg)' : 'var(--text-primary)',
                          borderColor: selected ? 'transparent' : 'var(--border-hairline)',
                        }}
                      >
                        {val === '对' ? '正确' : '错误'}
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === 'short' && (
                <textarea
                  value={answers[q.id] || ''}
                  onChange={(e) => setAnswers((p) => ({ ...p, [q.id]: e.target.value }))}
                  rows={4}
                  placeholder="写出核心要点，交卷后由 AI 自动评分点评..."
                  className="w-full p-3.5 rounded-xl zw-input text-sm"
                />
              )}
            </div>
          ))}
        </div>

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full py-3.5 rounded-2xl zw-btn-primary font-semibold text-sm disabled:opacity-50 cursor-pointer"
        >
          {submitting ? '正在批改并归档错题...' : '提交试卷'}
        </button>
      </div>
    );
  }

  if (view === 'result' && activeQuiz?.questions) {
    const pct = Math.round((activeQuiz.score || 0) * 100);
    return (
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="p-6 rounded-2xl zw-card flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="text-xs text-[var(--text-muted)]">测验完成</div>
            <h2 className="text-lg font-semibold mt-0.5">{activeQuiz.title}</h2>
            <p className="text-xs mt-1" style={{ color: activeQuiz.mistakesAdded ? 'var(--danger-fg)' : 'var(--ok-fg)' }}>
              {activeQuiz.mistakesAdded
                ? `已自动收录 ${activeQuiz.mistakesAdded} 道错题至错题集并排入复习计划`
                : '全部过关，表现出色'}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-3xl font-semibold tracking-tight tabular-nums">{pct}%</div>
              <div className="text-[10px] text-[var(--text-muted)]">得分</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => onNavigate('home', { masteryChanges: activeQuiz.masteryChanges })}
                className="px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer">返回今日学习</button>
              <button onClick={() => setView('setup')} className="px-4 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer">再出一套</button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {activeQuiz.questions.map((q, idx) => (
            <div key={q.id} className="p-5 rounded-2xl zw-card space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {q.is_correct ? (
                    <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--ok-fg)' }} />
                  ) : (
                    <XCircle className="w-4 h-4" style={{ color: 'var(--danger-fg)' }} />
                  )}
                  <span className="font-semibold text-xs">第 {idx + 1} 题</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{q.concept_name}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={async () => {
                      await api.bookmarkMistake(q.id);
                      setBookmarked((p) => ({ ...p, [q.id]: true }));
                      onRefreshGlobal();
                    }}
                    disabled={bookmarked[q.id]}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg zw-btn-secondary text-[11px] cursor-pointer"
                  >
                    <BookmarkPlus className="w-3 h-3" />
                    {bookmarked[q.id] ? '已收藏' : '收错题本'}
                  </button>
                  <button
                    onClick={() =>
                      onNavigate('tutor', {
                        mode: 'qa',
                        noteIds: q.note_id ? [q.note_id] : [],
                        title: `题目答疑：${q.concept_name}`,
                        initialPrompt: `请帮我深入讲透这道题：${q.stem}（参考答案：${q.correct_answer}）`,
                      })
                    }
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg zw-btn-secondary text-[11px] cursor-pointer"
                  >
                    <MessageSquareText className="w-3 h-3" />
                    追问
                  </button>
                </div>
              </div>

              <p className="text-sm font-medium">{q.stem}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div
                  className="p-2.5 rounded-xl border"
                  style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
                >
                  <span className="text-[var(--text-muted)]">你的作答：</span>
                  <span style={{ color: q.is_correct ? 'var(--ok-fg)' : 'var(--danger-fg)' }} className="font-medium">
                    {q.user_answer || '未作答'}
                  </span>
                </div>
                <div
                  className="p-2.5 rounded-xl border"
                  style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok-border)', color: 'var(--ok-fg)' }}
                >
                  <span>参考答案：</span>
                  <span className="font-semibold">{q.correct_answer}</span>
                </div>
              </div>

              {q.ai_feedback && (
                <div
                  className="p-3 rounded-xl border text-xs"
                  style={{ background: 'var(--warn-bg)', borderColor: 'var(--warn-border)', color: 'var(--warn-fg)' }}
                >
                  <strong>AI 点评：</strong>
                  {q.ai_feedback}
                </div>
              )}

              <div
                className="p-3.5 rounded-xl text-xs text-[var(--text-secondary)] space-y-1 leading-relaxed"
                style={{ background: 'var(--bg-subtle)' }}
              >
                <div>
                  <strong className="text-[var(--text-primary)]">解析：</strong>
                  {q.explanation}
                </div>
                {q.memory_tip && <div className="text-[var(--text-primary)] pt-1">记忆点：{q.memory_tip}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      <div className="lg:col-span-7 p-5 sm:p-6 rounded-2xl zw-card space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">动态出题</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">基于个人笔记实时组卷，交卷自动沉淀错题至复习计划。</p>
        </div>

        <div className="space-y-2.5">
          <label className="text-xs font-medium text-[var(--text-secondary)]">1. 出题范围</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'notes', label: '指定笔记' },
              { id: 'category', label: '学科分类' },
              { id: 'weak', label: '知识点专项' },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => setSourceMode(m.id as any)}
                className="py-2 rounded-xl text-xs font-medium border transition cursor-pointer"
                style={{
                  background: sourceMode === m.id ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                  color: sourceMode === m.id ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                  borderColor: sourceMode === m.id ? 'transparent' : 'var(--border-hairline)',
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {sourceMode === 'notes' && (
            <div
              className="max-h-48 overflow-y-auto border rounded-xl p-2 space-y-1"
              style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
            >
              {notes.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] p-4 text-center">请先导入至少一篇笔记</p>
              ) : (
                notes.map((n) => {
                  const checked = selectedNoteIds.includes(n.id);
                  return (
                    <label
                      key={n.id}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer text-xs transition"
                      style={{ background: checked ? 'var(--bg-active)' : 'transparent' }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedNoteIds((p) => (p.includes(n.id) ? p.filter((x) => x !== n.id) : [...p, n.id]))
                        }
                        className="accent-[var(--text-primary)]"
                      />
                      <span className="truncate flex-1 font-medium">{n.title}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">{n.category_name || '未分类'}</span>
                    </label>
                  );
                })
              )}
            </div>
          )}

          {sourceMode === 'category' && (
            <select
              value={selectedCatId}
              onChange={(e) => setSelectedCatId(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl zw-input text-xs"
            >
              <option value="">全部最近笔记</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id} disabled={!notes.some((note) => note.category_id === c.id)}>
                  {categoryLabels.get(c.id) ?? c.name} ({c.note_count || 0} 篇)
                </option>
              ))}
            </select>
          )}

          {sourceMode === 'weak' && (
            <div
              className="p-3.5 rounded-xl border text-xs"
              style={{ background: 'var(--warn-bg)', borderColor: 'var(--warn-border)', color: 'var(--warn-fg)' }}
            >
              {focusConcepts.length ? `围绕 ${focusConcepts.join('、')} 的关联笔记出题。` : '根据已评估的薄弱知识点及其关联笔记出题。'}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--text-secondary)]">2. 难度</label>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { id: 'easy', label: '基础' },
                { id: 'medium', label: '进阶' },
                { id: 'hard', label: '挑战' },
              ].map((d) => (
                <button
                  key={d.id}
                  onClick={() => setDifficulty(d.id as any)}
                  className="py-2 rounded-xl text-xs font-medium border cursor-pointer"
                  style={{
                    background: difficulty === d.id ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                    color: difficulty === d.id ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                    borderColor: difficulty === d.id ? 'transparent' : 'var(--border-hairline)',
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--text-secondary)]">3. 题量：{count} 题</label>
            <div className="grid grid-cols-4 gap-1.5">
              {[3, 5, 8, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className="py-2 rounded-xl text-xs font-medium border cursor-pointer tabular-nums"
                  style={{
                    background: count === n ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                    color: count === n ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                    borderColor: count === n ? 'transparent' : 'var(--border-hairline)',
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-[var(--text-secondary)]">4. 题型</label>
          <div className="flex flex-wrap gap-2">
            {QUESTION_TYPES.map((t) => {
              const active = selectedTypes.includes(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => toggleType(t.id)}
                  className="px-3.5 py-2 rounded-xl text-xs font-medium border transition cursor-pointer"
                  style={{
                    background: active ? 'var(--bg-active)' : 'var(--bg-subtle)',
                    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                    borderColor: active ? 'var(--border-strong)' : 'var(--border-hairline)',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div
            className="p-3 rounded-xl border text-xs"
            style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)', color: 'var(--danger-fg)' }}
          >
            {error}
          </div>
        )}

        <button
          onClick={handleGenerate}
          disabled={generating || !hasSource}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl zw-btn-primary font-semibold text-sm disabled:opacity-50 cursor-pointer"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {generating ? '正在生成试卷...' : '生成动态测验'}
        </button>
      </div>

      {/* History */}
      <div className="lg:col-span-5 p-5 rounded-2xl zw-card space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Clock className="w-4 h-4 text-[var(--text-muted)]" />
          历史测验
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] py-8 text-center">暂无历史记录</p>
        ) : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {history.map((q) => (
              <div
                key={q.id}
                onClick={() => openQuiz(q.id)}
                className="p-3.5 rounded-xl border transition cursor-pointer flex items-center justify-between gap-2 hover:border-[var(--border-strong)]"
                style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{q.title}</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5 tabular-nums">
                    {q.total_questions} 题 · {new Date(q.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {q.status === 'completed' && q.score !== null ? (
                    <span
                      className="text-xs font-semibold tabular-nums px-2 py-0.5 rounded-md"
                      style={{ background: 'var(--ok-bg)', color: 'var(--ok-fg)' }}
                    >
                      {Math.round(q.score * 100)}%
                    </span>
                  ) : (
                    <span
                      className="text-[11px] px-2 py-0.5 rounded-md"
                      style={{ background: 'var(--warn-bg)', color: 'var(--warn-fg)' }}
                    >
                      进行中
                    </span>
                  )}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      await api.deleteQuiz(q.id);
                      loadInit();
                    }}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--danger-fg)]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
