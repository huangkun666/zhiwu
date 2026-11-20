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
import type { Category, Note, PageId, Quiz } from '../types';

interface QuizPageProps {
  categories: Category[];
  initialContext?: { noteIds?: string[]; weakOnly?: boolean; focusConcepts?: string[] } | null;
  onRefreshGlobal: () => void;
  onNavigate: (page: PageId, context?: any) => void;
}

const QUESTION_TYPES = [
  { id: 'single', label: '单选题' },
  { id: 'multiple', label: '多选题' },
  { id: 'boolean', label: '判断题' },
  { id: 'short', label: '简答题 (AI批改)' },
] as const;

export function QuizPage({ categories, initialContext, onRefreshGlobal, onNavigate }: QuizPageProps) {
  const [view, setView] = useState<'setup' | 'taking' | 'result'>('setup');
  const [notes, setNotes] = useState<Note[]>([]);
  const [history, setHistory] = useState<Quiz[]>([]);

  // Generator config
  const [sourceMode, setSourceMode] = useState<'notes' | 'category' | 'weak'>('notes');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [selectedCatId, setSelectedCatId] = useState<string>('');
  const [focusConcepts, setFocusConcepts] = useState<string[]>([]);
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [selectedTypes, setSelectedTypes] = useState<('single' | 'multiple' | 'boolean' | 'short')[]>([
    'single',
    'boolean',
    'short',
  ]);

  // Active Quiz state
  const [activeQuiz, setActiveQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bookmarked, setBookmarked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');

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
    setError('');
    setGenerating(true);
    try {
      const quiz = await api.generateQuiz({
        noteIds: sourceMode === 'notes' ? selectedNoteIds : [],
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
    if (q.status === 'completed') {
      setView('result');
    } else {
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
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 rounded-2xl bg-white border border-[#EAE6DF] sticky top-14 md:top-4 z-20 shadow-sm">
          <div>
            <h2 className="font-bold text-base text-[#141311]">{activeQuiz.title}</h2>
            <p className="text-xs text-[#7A756C]">
              已完成 {answeredCount} / {activeQuiz.questions.length} 题
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setView('setup')}
              className="px-3 py-2 rounded-xl text-xs font-medium bg-[#F5F3EE] text-[#524F49]"
            >
              返回
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold hover:bg-[#2F4AC2] disabled:opacity-60 cursor-pointer"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck2 className="w-4 h-4" />}
              {submitting ? 'AI 批改中...' : '交卷批改'}
            </button>
          </div>
        </div>

        {error && <div className="p-3 rounded-xl bg-red-50 text-red-700 text-xs">{error}</div>}

        <div className="space-y-4">
          {activeQuiz.questions.map((q, idx) => (
            <div key={q.id} className="p-5 rounded-2xl bg-white border border-[#EAE6DF] space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-[#F3F5FC] text-[#3B5BDB]">
                  第 {idx + 1} 题 ·{' '}
                  {q.type === 'single' ? '单选' : q.type === 'multiple' ? '多选' : q.type === 'boolean' ? '判断' : '简答'}
                </span>
                {q.concept_name && <span className="text-xs text-[#8A857C]">考点：{q.concept_name}</span>}
              </div>

              <p className="text-sm sm:text-base font-medium text-[#141311] leading-relaxed">{q.stem}</p>

              {q.type === 'single' && (
                <div className="space-y-2">
                  {q.options.map((opt, i) => {
                    const letter = opt.match(/^([A-D])[.、\s]/i)?.[1]?.toUpperCase() || String.fromCharCode(65 + i);
                    const selected = answers[q.id] === letter;
                    return (
                      <button
                        key={i}
                        onClick={() => setAnswers((p) => ({ ...p, [q.id]: letter }))}
                        className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition cursor-pointer ${
                          selected
                            ? 'bg-[#F3F5FC] border-[#3B5BDB] text-[#1E2B58] font-medium'
                            : 'bg-[#FAF9F6] border-[#E8E5DF] hover:border-[#CFCAC0]'
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === 'multiple' && (
                <div className="space-y-2">
                  {q.options.map((opt, i) => {
                    const letter = opt.match(/^([A-D])[.、\s]/i)?.[1]?.toUpperCase() || String.fromCharCode(65 + i);
                    const selected = (answers[q.id] || '').split(',').includes(letter);
                    return (
                      <button
                        key={i}
                        onClick={() => toggleMultipleOption(q.id, letter)}
                        className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition cursor-pointer ${
                          selected
                            ? 'bg-[#F3F5FC] border-[#3B5BDB] text-[#1E2B58] font-medium'
                            : 'bg-[#FAF9F6] border-[#E8E5DF] hover:border-[#CFCAC0]'
                        }`}
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
                        className={`py-3 rounded-xl border text-sm font-semibold transition cursor-pointer ${
                          selected
                            ? 'bg-[#3B5BDB] border-[#3B5BDB] text-white'
                            : 'bg-[#FAF9F6] border-[#E8E5DF] text-[#3D3A35]'
                        }`}
                      >
                        {val === '对' ? '✓ 正确' : '✕ 错误'}
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
                  placeholder="用自己的话写出核心要点，交卷后 AI 将自动对照解析评分并反馈遗漏点..."
                  className="w-full p-3.5 rounded-xl border border-[#DDD8CE] bg-[#FAF9F6] text-sm focus:outline-none focus:border-[#3B5BDB] focus:bg-white"
                />
              )}
            </div>
          ))}
        </div>

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full py-3.5 rounded-2xl bg-[#3B5BDB] text-white font-bold text-sm hover:bg-[#2F4AC2] shadow-sm disabled:opacity-60 cursor-pointer"
        >
          {submitting ? '正在智能批改并归档错题...' : '提交试卷并查看解析'}
        </button>
      </div>
    );
  }

  if (view === 'result' && activeQuiz?.questions) {
    const pct = Math.round((activeQuiz.score || 0) * 100);
    return (
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="p-6 rounded-2xl bg-gradient-to-br from-[#F3F5FC] to-white border border-[#3B5BDB]/20 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className="text-xs font-semibold text-[#3B5BDB]">测验已完成</span>
            <h2 className="text-xl font-bold text-[#141311] mt-0.5">{activeQuiz.title}</h2>
            {activeQuiz.mistakesAdded ? (
              <p className="text-xs text-red-600 mt-1 font-medium">
                已自动将 {activeQuiz.mistakesAdded} 道错题收录至「错题集」并排入间隔重复复习计划！
              </p>
            ) : (
              <p className="text-xs text-emerald-700 mt-1 font-medium">表现出色！继续保持主动提取练习。</p>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <div className="text-3xl font-extrabold text-[#3B5BDB]">{pct}%</div>
              <div className="text-[11px] text-[#7A756C]">综合得分</div>
            </div>
            <button
              onClick={() => setView('setup')}
              className="px-4 py-2.5 rounded-xl bg-[#1C1B18] text-white text-xs font-semibold cursor-pointer"
            >
              再出一套题
            </button>
          </div>
        </div>

        <div className="space-y-4">
          {activeQuiz.questions.map((q, idx) => (
            <div
              key={q.id}
              className={`p-5 rounded-2xl bg-white border space-y-3 ${
                q.is_correct ? 'border-emerald-200' : 'border-red-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {q.is_correct ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-600" />
                  )}
                  <span className="font-bold text-sm text-[#141311]">第 {idx + 1} 题</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-[#F5F3EE] text-[#524F49]">{q.concept_name}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={async () => {
                      await api.bookmarkMistake(q.id);
                      setBookmarked((p) => ({ ...p, [q.id]: true }));
                      onRefreshGlobal();
                    }}
                    disabled={bookmarked[q.id]}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#F5F3EE] text-xs text-[#4A4741] hover:bg-[#ECE9E2] cursor-pointer"
                  >
                    <BookmarkPlus className="w-3.5 h-3.5" />
                    {bookmarked[q.id] ? '已收藏' : '收进错题本'}
                  </button>
                  <button
                    onClick={() =>
                      onNavigate('tutor', {
                        mode: 'qa',
                        noteIds: q.note_id ? [q.note_id] : [],
                        title: `题目答疑：${q.concept_name}`,
                        initialPrompt: `请帮我深入讲透这道题：${q.stem}（正确答案：${q.correct_answer}）`,
                      })
                    }
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#F3F5FC] text-xs text-[#3B5BDB] cursor-pointer"
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                    追问
                  </button>
                </div>
              </div>

              <p className="text-sm font-medium text-[#1C1B18]">{q.stem}</p>

              {q.options.length > 0 && (
                <div className="space-y-1 text-xs text-[#4A4741] pl-1">
                  {q.options.map((opt, i) => (
                    <div key={i}>{opt}</div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-xl bg-[#FAF9F6] border border-[#ECE9E2]">
                  <span className="text-[#8A857C]">你的作答：</span>
                  <span className={`font-semibold ${q.is_correct ? 'text-emerald-700' : 'text-red-600'}`}>
                    {q.user_answer || '未作答'}
                  </span>
                </div>
                <div className="p-2.5 rounded-xl bg-emerald-50/70 border border-emerald-200">
                  <span className="text-emerald-800">参考答案：</span>
                  <span className="font-semibold text-emerald-900">{q.correct_answer}</span>
                </div>
              </div>

              {q.ai_feedback && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                  <strong>AI 阅卷点评：</strong>
                  {q.ai_feedback}
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-[#F3F5FC] text-xs text-[#263159] space-y-1 leading-relaxed">
                <div>
                  <strong>题目解析：</strong>
                  {q.explanation}
                </div>
                {q.memory_tip && (
                  <div className="text-[#3B5BDB] font-medium pt-1">💡 记忆锚点：{q.memory_tip}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Setup & History View
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* Left: Dynamic Quiz Generator */}
      <div className="lg:col-span-7 p-5 sm:p-6 rounded-2xl bg-white border border-[#EAE6DF] space-y-5">
        <div>
          <h1 className="text-xl font-bold text-[#141311]">动态智能出题</h1>
          <p className="text-xs text-[#7A756C] mt-1">
            紧贴你的个人学习笔记实时组卷，交卷自动批改并将错题沉淀至错题集与艾宾浩斯复习计划。
          </p>
        </div>

        {/* Source Mode */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-[#4A4741]">1. 选择出题范围</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'notes', label: '指定笔记' },
              { id: 'category', label: '按学科分类' },
              { id: 'weak', label: '薄弱项专项' },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => setSourceMode(m.id as any)}
                className={`py-2.5 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                  sourceMode === m.id
                    ? 'bg-[#3B5BDB] border-[#3B5BDB] text-white'
                    : 'bg-[#FAF9F6] border-[#E5E2DC] text-[#524F49]'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {sourceMode === 'notes' && (
            <div className="max-h-48 overflow-y-auto border border-[#EAE6DF] rounded-xl p-2 space-y-1 bg-[#FAF9F6]">
              {notes.length === 0 ? (
                <p className="text-xs text-[#8A857C] p-4 text-center">暂无笔记，请先导入学习笔记</p>
              ) : (
                notes.map((n) => {
                  const checked = selectedNoteIds.includes(n.id);
                  return (
                    <label
                      key={n.id}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer text-xs ${
                        checked ? 'bg-[#F3F5FC] text-[#1E2B58] font-medium' : 'hover:bg-white'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedNoteIds((p) => (p.includes(n.id) ? p.filter((x) => x !== n.id) : [...p, n.id]))
                        }
                        className="accent-[#3B5BDB]"
                      />
                      <span className="truncate flex-1">{n.title}</span>
                      <span className="text-[10px] text-[#8A857C]">{n.category_name || '未分类'}</span>
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
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#DDD8CE] bg-[#FAF9F6] text-sm"
            >
              <option value="">全部最近笔记</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.note_count || 0} 篇)
                </option>
              ))}
            </select>
          )}

          {sourceMode === 'weak' && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
              系统将自动提取你历史正确率最低、错题最多的核心知识点{focusConcepts.length ? `（当前聚焦：${focusConcepts.join('、')}）` : ''}，关联对应笔记精准出题。
            </div>
          )}
        </div>

        {/* Difficulty & Count */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-[#4A4741]">2. 题目难度</label>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { id: 'easy', label: '基础' },
                { id: 'medium', label: '进阶' },
                { id: 'hard', label: '挑战' },
              ].map((d) => (
                <button
                  key={d.id}
                  onClick={() => setDifficulty(d.id as any)}
                  className={`py-2 rounded-xl text-xs font-semibold border cursor-pointer ${
                    difficulty === d.id
                      ? 'bg-[#1C1B18] border-[#1C1B18] text-white'
                      : 'bg-white border-[#E5E2DC] text-[#524F49]'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-[#4A4741]">3. 出题数量：{count} 题</label>
            <div className="grid grid-cols-4 gap-1.5">
              {[3, 5, 8, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className={`py-2 rounded-xl text-xs font-semibold border cursor-pointer ${
                    count === n
                      ? 'bg-[#1C1B18] border-[#1C1B18] text-white'
                      : 'bg-white border-[#E5E2DC] text-[#524F49]'
                  }`}
                >
                  {n} 题
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Question Types */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-[#4A4741]">4. 题型组合（可多选）</label>
          <div className="flex flex-wrap gap-2">
            {QUESTION_TYPES.map((t) => {
              const active = selectedTypes.includes(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => toggleType(t.id)}
                  className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                    active
                      ? 'bg-[#F3F5FC] border-[#3B5BDB] text-[#3B5BDB]'
                      : 'bg-white border-[#E5E2DC] text-[#6F6B63]'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {error && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs">{error}</div>}

        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-[#3B5BDB] text-white font-bold text-sm hover:bg-[#2F4AC2] shadow-sm disabled:opacity-60 cursor-pointer"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {generating ? 'AI 正在根据你的笔记动态出题...' : '立即生成动态测验'}
        </button>
      </div>

      {/* Right: Quiz History */}
      <div className="lg:col-span-5 p-5 rounded-2xl bg-white border border-[#EAE6DF] space-y-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-[#6F6B63]" />
          <h3 className="font-bold text-sm text-[#141311]">历史测验记录</h3>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-[#8A857C] py-8 text-center">暂无历史测验，在左侧生成你的第一套题吧</p>
        ) : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {history.map((q) => (
              <div
                key={q.id}
                onClick={() => openQuiz(q.id)}
                className="p-3.5 rounded-xl bg-[#FAF9F6] hover:bg-[#F3F5FC] border border-[#EFECE6] transition cursor-pointer flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[#141311] truncate">{q.title}</div>
                  <div className="text-[11px] text-[#8A857C] mt-0.5">
                    {q.total_questions} 题 · {new Date(q.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {q.status === 'completed' && q.score !== null ? (
                    <span className="text-xs font-bold px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-700">
                      {Math.round(q.score * 100)}%
                    </span>
                  ) : (
                    <span className="text-[11px] px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800">进行中</span>
                  )}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      await api.deleteQuiz(q.id);
                      loadInit();
                    }}
                    className="p-1 text-[#9C978E] hover:text-red-600"
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
