import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { MarkdownView } from '../components/MarkdownView';
import type { Mistake, PageId } from '../types';

interface MistakesPageProps {
  onRefreshGlobal: () => void;
  onNavigate: (page: PageId, context?: any) => void;
}

export function MistakesPage({ onRefreshGlobal, onNavigate }: MistakesPageProps) {
  const [statusFilter, setStatusFilter] = useState<'all' | 'unmastered' | 'reviewing' | 'mastered'>('all');
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reflections, setReflections] = useState<Record<string, string>>({});
  const [toast, setToast] = useState('');

  // Closed-loop Variant Question Modal (automatically feeds back into SM-2 mastery!)
  const [variantModal, setVariantModal] = useState<{
    mistake: Mistake;
    question: {
      conceptName: string;
      type: string;
      stem: string;
      options: string[];
      correctAnswer: string;
      explanation: string;
      memoryTip: string;
    };
    userAnswer: string;
    revealed: boolean;
    autoPassed: boolean | null;
    synced: boolean;
  } | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const list = await api.getMistakes({ status: statusFilter });
      setMistakes(list);
      const refMap: Record<string, string> = {};
      list.forEach((m) => (refMap[m.id] = m.user_reflection || ''));
      setReflections(refMap);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [statusFilter]);

  const handleDiagnose = async (m: Mistake) => {
    setBusyId(m.id);
    try {
      const updated = await api.diagnoseMistake(m.id);
      setMistakes((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleVariant = async (m: Mistake) => {
    setBusyId(m.id);
    try {
      const q = await api.generateVariant(m.id);
      setVariantModal({
        mistake: m,
        question: q,
        userAnswer: '',
        revealed: false,
        autoPassed: null,
        synced: false,
      });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleRevealVariant = async () => {
    if (!variantModal) return;
    const { question, userAnswer, mistake } = variantModal;
    let passed: boolean | null = null;
    if (question.options.length > 0 && userAnswer) {
      const norm = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');
      passed = norm(userAnswer) !== '' && norm(userAnswer) === norm(question.correctAnswer);
    }
    setVariantModal((p) => (p ? { ...p, revealed: true, autoPassed: passed } : null));

    // Automatically close the loop: if objective variant was answered correctly, advance SM-2 mastery!
    if (passed === true) {
      try {
        const res = await api.reviewMistake(mistake.id, 3);
        setMistakes((prev) => prev.map((x) => (x.id === mistake.id ? res.mistake : x)));
        onRefreshGlobal();
        setVariantModal((p) => (p ? { ...p, synced: true } : null));
        showToast(`举一反三通过！已自动推进错题复习进度（下次：${res.nextLabel}）`);
      } catch {
        // ignore
      }
    }
  };

  const handleManualVariantSync = async (rating: 1 | 3 | 4) => {
    if (!variantModal) return;
    const res = await api.reviewMistake(variantModal.mistake.id, rating);
    setMistakes((prev) => prev.map((x) => (x.id === variantModal.mistake.id ? res.mistake : x)));
    onRefreshGlobal();
    setVariantModal((p) => (p ? { ...p, synced: true } : null));
    showToast(`已更新错题掌握状态（下次复习：${res.nextLabel}）`);
  };

  const handleSaveReflection = async (m: Mistake) => {
    const updated = await api.updateMistake(m.id, { userReflection: reflections[m.id] || '' });
    setMistakes((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
    showToast('反思已保存');
  };

  const handleStatusChange = async (m: Mistake, status: Mistake['status']) => {
    const updated = await api.updateMistake(m.id, { status });
    setMistakes((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
    onRefreshGlobal();
  };

  const handleSM2Review = async (m: Mistake, rating: 1 | 2 | 3 | 4) => {
    const res = await api.reviewMistake(m.id, rating);
    setMistakes((prev) => prev.map((x) => (x.id === m.id ? res.mistake : x)));
    onRefreshGlobal();
    showToast(`下次复习：${res.nextLabel}`);
  };

  const statusBadge = (s: Mistake['status']) => {
    if (s === 'mastered')
      return (
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md" style={{ background: 'var(--ok-bg)', color: 'var(--ok-fg)' }}>
          已攻克
        </span>
      );
    if (s === 'reviewing')
      return (
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md" style={{ background: 'var(--warn-bg)', color: 'var(--warn-fg)' }}>
          复习中
        </span>
      );
    return (
      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md" style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}>
        待攻克
      </span>
    );
  };

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2.5 rounded-xl zw-btn-primary text-xs font-medium shadow-lg">
          {toast}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">错题集</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            支持 AI 根因剖析与同类变式题验证（变式题答对将自动推进复习进度）。
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[
            { id: 'all', label: '全部' },
            { id: 'unmastered', label: '待攻克' },
            { id: 'reviewing', label: '复习中' },
            { id: 'mastered', label: '已攻克' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id as any)}
              className="px-3 py-1.5 rounded-xl text-xs font-medium border transition cursor-pointer"
              style={{
                background: statusFilter === tab.id ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                color: statusFilter === tab.id ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                borderColor: statusFilter === tab.id ? 'transparent' : 'var(--border-hairline)',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="p-12 text-center text-xs text-[var(--text-muted)]">加载中...</div>
      ) : mistakes.length === 0 ? (
        <div className="p-12 rounded-2xl zw-card text-center space-y-2">
          <CheckCircle2 className="w-8 h-8 mx-auto" style={{ color: 'var(--ok-fg)' }} />
          <p className="text-sm font-medium">当前筛选下没有错题</p>
        </div>
      ) : (
        <div className="space-y-4">
          {mistakes.map((m) => (
            <div key={m.id} className="p-5 rounded-2xl zw-card space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {statusBadge(m.status)}
                  <span
                    className="px-2 py-0.5 rounded-md font-medium"
                    style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                  >
                    {m.concept_name || '知识点'}
                  </span>
                  <span className="flex items-center gap-1 text-[var(--text-muted)] tabular-nums">
                    <AlertTriangle className="w-3 h-3" /> 错 {m.wrong_count} 次
                  </span>
                  {m.note_id && (
                    <button
                      onClick={() => onNavigate('notes', { noteId: m.note_id })}
                      className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer"
                    >
                      <BookOpen className="w-3 h-3" />
                      {m.note_title || '关联笔记'}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={m.status}
                    onChange={(e) => handleStatusChange(m, e.target.value as any)}
                    className="text-xs px-2 py-1 rounded-lg zw-input"
                  >
                    <option value="unmastered">待攻克</option>
                    <option value="reviewing">复习中</option>
                    <option value="mastered">已攻克</option>
                  </select>
                  <button
                    onClick={async () => {
                      if (!confirm('移除这条错题记录？')) return;
                      await api.deleteMistake(m.id);
                      load();
                      onRefreshGlobal();
                    }}
                    className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger-fg)] cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm sm:text-[15px] font-medium leading-relaxed">{m.stem}</p>
                {m.options.length > 0 && (
                  <div className="space-y-1.5">
                    {m.options.map((opt, idx) => {
                      const letter = opt.match(/^([A-D])[.、\s]/i)?.[1]?.toUpperCase() || '';
                      const isCorrectOpt = letter && m.correct_answer.toUpperCase().includes(letter);
                      const isWrongOpt = letter && m.wrong_answer.toUpperCase().includes(letter) && !isCorrectOpt;
                      const style = isCorrectOpt
                        ? { background: 'var(--ok-bg)', borderColor: 'var(--ok-border)', color: 'var(--ok-fg)' }
                        : isWrongOpt
                        ? { background: 'var(--danger-bg)', borderColor: 'var(--danger-border)', color: 'var(--danger-fg)' }
                        : { background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)', color: 'var(--text-secondary)' };
                      return (
                        <div key={idx} className="px-3.5 py-2 rounded-xl text-xs border" style={style}>
                          {opt}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                <div
                  className="p-2.5 rounded-xl border"
                  style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)', color: 'var(--danger-fg)' }}
                >
                  曾误答：<strong>{m.wrong_answer || '未作答'}</strong>
                </div>
                <div
                  className="p-2.5 rounded-xl border"
                  style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok-border)', color: 'var(--ok-fg)' }}
                >
                  正确答案：<strong>{m.correct_answer}</strong>
                </div>
              </div>

              <div
                className="p-4 rounded-xl border space-y-2 text-xs text-[var(--text-secondary)]"
                style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
              >
                <div>
                  <strong className="text-[var(--text-primary)]">标准解析：</strong>
                  {m.explanation}
                </div>
                {m.ai_diagnosis && (
                  <div className="pt-2 border-t" style={{ borderColor: 'var(--border-hairline)' }}>
                    <div className="font-semibold text-[var(--text-primary)] mb-1 flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5" /> AI 错因剖析
                    </div>
                    <MarkdownView content={m.ai_diagnosis} className="text-xs" />
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <input
                  value={reflections[m.id] || ''}
                  onChange={(e) => setReflections((p) => ({ ...p, [m.id]: e.target.value }))}
                  placeholder="记录你的避坑反思..."
                  className="flex-1 px-3.5 py-2 rounded-xl zw-input text-xs"
                />
                <button
                  onClick={() => handleSaveReflection(m)}
                  className="flex items-center gap-1 px-3 py-2 rounded-xl zw-btn-secondary text-xs cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  保存
                </button>
              </div>

              <div
                className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => handleDiagnose(m)}
                    disabled={busyId === m.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer disabled:opacity-50"
                  >
                    {busyId === m.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    AI 深度剖析
                  </button>
                  <button
                    onClick={() => handleVariant(m)}
                    disabled={busyId === m.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    举一反三变式题
                  </button>
                  <button
                    onClick={() =>
                      onNavigate('tutor', {
                        mode: 'feynman',
                        noteIds: m.note_id ? [m.note_id] : [],
                        title: `错题攻克：${m.concept_name}`,
                        initialPrompt: `我之前做错了这道题：${m.stem}。请用费曼提问法帮我彻底理清背后的逻辑！`,
                      })
                    }
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                    问助教
                  </button>
                </div>

                <div className="flex items-center gap-1.5 text-[11px]">
                  {[
                    { r: 1 as const, label: '仍不会' },
                    { r: 2 as const, label: '较模糊' },
                    { r: 3 as const, label: '已理解' },
                    { r: 4 as const, label: '秒懂' },
                  ].map((btn) => (
                    <button
                      key={btn.r}
                      onClick={() => handleSM2Review(m, btn.r)}
                      className="px-2.5 py-1 rounded-lg zw-btn-secondary font-medium cursor-pointer"
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Closed-Loop Variant Question Modal */}
      {variantModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
          onClick={() => setVariantModal(null)}
        >
          <div
            className="w-full max-w-lg zw-modal rounded-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-5 py-4 border-b"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <div>
                <h3 className="font-semibold text-sm">举一反三 · 同类变式题</h3>
                <p className="text-[11px] text-[var(--text-muted)]">考点：{variantModal.question.conceptName}</p>
              </div>
              <button onClick={() => setVariantModal(null)} className="p-1.5 rounded-lg text-[var(--text-muted)] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              <p className="text-sm font-medium leading-relaxed">{variantModal.question.stem}</p>

              {variantModal.question.options.length > 0 ? (
                <div className="space-y-2">
                  {variantModal.question.options.map((opt, idx) => {
                    const letter = opt.match(/^([A-D])[.、\s]/i)?.[1]?.toUpperCase() || opt;
                    const selected = variantModal.userAnswer === letter;
                    return (
                      <button
                        key={idx}
                        disabled={variantModal.revealed}
                        onClick={() => setVariantModal((p) => (p ? { ...p, userAnswer: letter } : null))}
                        className="w-full text-left px-3.5 py-2.5 rounded-xl border text-xs transition cursor-pointer"
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
              ) : (
                <textarea
                  value={variantModal.userAnswer}
                  onChange={(e) => setVariantModal((p) => (p ? { ...p, userAnswer: e.target.value } : null))}
                  rows={3}
                  placeholder="写下你的思路..."
                  className="w-full p-3 rounded-xl zw-input text-xs"
                />
              )}

              {variantModal.revealed ? (
                <div className="space-y-3">
                  <div
                    className="p-4 rounded-xl border space-y-1.5 text-xs"
                    style={{
                      background: variantModal.autoPassed === false ? 'var(--danger-bg)' : 'var(--ok-bg)',
                      borderColor: variantModal.autoPassed === false ? 'var(--danger-border)' : 'var(--ok-border)',
                      color: variantModal.autoPassed === false ? 'var(--danger-fg)' : 'var(--ok-fg)',
                    }}
                  >
                    <div className="font-semibold">
                      {variantModal.autoPassed === true
                        ? '✓ 变式题答对！（已自动推进该错题的 SM-2 复习掌握进度）'
                        : variantModal.autoPassed === false
                        ? '✕ 变式题未答对，建议结合解析再巩固一次'
                        : `参考答案：${variantModal.question.correctAnswer}`}
                    </div>
                    {variantModal.autoPassed !== null && (
                      <div>参考答案：{variantModal.question.correctAnswer}</div>
                    )}
                    <div className="leading-relaxed opacity-90">{variantModal.question.explanation}</div>
                  </div>

                  {!variantModal.synced && (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-[11px] text-[var(--text-muted)]">同步本次演练结果到错题进度：</span>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => handleManualVariantSync(1)}
                          className="px-2.5 py-1.5 rounded-lg zw-btn-secondary text-xs cursor-pointer"
                        >
                          还需重练
                        </button>
                        <button
                          onClick={() => handleManualVariantSync(3)}
                          className="px-3 py-1.5 rounded-lg zw-btn-primary text-xs font-semibold cursor-pointer"
                        >
                          已掌握，推进进度
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleRevealVariant}
                  className="w-full py-2.5 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
                >
                  核对答案并更新掌握度
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
