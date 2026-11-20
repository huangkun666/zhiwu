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

  // Variant question modal
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
  } | null>(null);

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
      setVariantModal({ mistake: m, question: q, userAnswer: '', revealed: false });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveReflection = async (m: Mistake) => {
    const updated = await api.updateMistake(m.id, { userReflection: reflections[m.id] || '' });
    setMistakes((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
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
  };

  const statusBadge = (s: Mistake['status']) => {
    if (s === 'mastered') return <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">已攻克</span>;
    if (s === 'reviewing') return <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">复习中</span>;
    return <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">待攻克</span>;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#141311]">错题集与深度解析</h1>
          <p className="text-xs text-[#7A756C] mt-0.5">
            每道错题自动接入遗忘曲线复习，支持 AI 根因诊断与「举一反三」变式题验证。
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
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
                statusFilter === tab.id ? 'bg-[#1C1B18] text-white' : 'bg-white border border-[#E5E2DC] text-[#524F49]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="p-12 text-center text-sm text-[#8A857C]">加载错题中...</div>
      ) : mistakes.length === 0 ? (
        <div className="p-12 rounded-2xl bg-white border border-[#EAE6DF] text-center space-y-2">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
          <p className="text-sm font-semibold text-[#1C1B18]">当前筛选下没有错题</p>
          <p className="text-xs text-[#8A857C]">去「动态出题」做一套测验，错题会自动归档到这里哦！</p>
        </div>
      ) : (
        <div className="space-y-4">
          {mistakes.map((m) => (
            <div key={m.id} className="p-5 rounded-2xl bg-white border border-[#EAE6DF] space-y-4">
              {/* Top Meta */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {statusBadge(m.status)}
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-lg bg-[#F3F5FC] text-[#3B5BDB]">
                    {m.concept_name || '知识点'}
                  </span>
                  <span className="text-xs text-red-600 font-medium flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> 错 {m.wrong_count} 次
                  </span>
                  {m.note_id && (
                    <button
                      onClick={() => onNavigate('notes', { noteId: m.note_id })}
                      className="text-xs text-[#6F6B63] hover:text-[#3B5BDB] flex items-center gap-1 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      {m.note_title || '查看关联笔记'}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={m.status}
                    onChange={(e) => handleStatusChange(m, e.target.value as any)}
                    className="text-xs px-2 py-1 rounded-lg border border-[#E5E2DC] bg-[#FAF9F6]"
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
                    className="p-1.5 rounded-lg text-[#9C978E] hover:text-red-600"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Question Stem & Options */}
              <div className="space-y-2">
                <p className="text-sm sm:text-base font-semibold text-[#141311] leading-relaxed">{m.stem}</p>
                {m.options.length > 0 && (
                  <div className="space-y-1.5">
                    {m.options.map((opt, idx) => {
                      const letter = opt.match(/^([A-D])[.、\s]/i)?.[1]?.toUpperCase() || '';
                      const isCorrectOpt = letter && m.correct_answer.toUpperCase().includes(letter);
                      const isWrongOpt = letter && m.wrong_answer.toUpperCase().includes(letter) && !isCorrectOpt;
                      return (
                        <div
                          key={idx}
                          className={`px-3.5 py-2 rounded-xl text-xs border ${
                            isCorrectOpt
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-900 font-medium'
                              : isWrongOpt
                              ? 'bg-red-50 border-red-200 text-red-800'
                              : 'bg-[#FAF9F6] border-[#EFECE6] text-[#4A4741]'
                          }`}
                        >
                          {opt}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Answer Comparison */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                <div className="p-3 rounded-xl bg-red-50/70 border border-red-100">
                  <span className="text-red-700 font-medium">曾误选/误答：</span>
                  <span className="text-red-900 font-semibold">{m.wrong_answer || '未作答'}</span>
                </div>
                <div className="p-3 rounded-xl bg-emerald-50/70 border border-emerald-100">
                  <span className="text-emerald-700 font-medium">正确答案：</span>
                  <span className="text-emerald-900 font-semibold">{m.correct_answer}</span>
                </div>
              </div>

              {/* Explanation & AI Diagnosis */}
              <div className="p-4 rounded-xl bg-[#FAF9F6] border border-[#EFECE6] space-y-2 text-xs text-[#3D3A35]">
                <div>
                  <strong className="text-[#141311]">标准解析：</strong>
                  {m.explanation}
                </div>
                {m.ai_diagnosis && (
                  <div className="pt-2 border-t border-[#E8E5DF]">
                    <div className="font-bold text-[#3B5BDB] mb-1 flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5" /> AI 深度错因剖析
                    </div>
                    <MarkdownView content={m.ai_diagnosis} className="text-xs" />
                  </div>
                )}
              </div>

              {/* User Reflection */}
              <div className="flex gap-2">
                <input
                  value={reflections[m.id] || ''}
                  onChange={(e) => setReflections((p) => ({ ...p, [m.id]: e.target.value }))}
                  placeholder="写下你的避坑反思（例如：为什么当时会选错？）"
                  className="flex-1 px-3.5 py-2 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-xs focus:outline-none focus:border-[#3B5BDB] focus:bg-white"
                />
                <button
                  onClick={() => handleSaveReflection(m)}
                  className="flex items-center gap-1 px-3 py-2 rounded-xl bg-[#F5F3EE] hover:bg-[#ECE9E2] text-xs font-medium text-[#3D3A35] cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  保存反思
                </button>
              </div>

              {/* Action Buttons & Quick SM-2 Rating */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#F2EFEA]">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => handleDiagnose(m)}
                    disabled={busyId === m.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F3F5FC] text-[#3B5BDB] text-xs font-semibold hover:bg-[#E8EDFA] cursor-pointer disabled:opacity-50"
                  >
                    {busyId === m.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    AI 深度剖析
                  </button>
                  <button
                    onClick={() => handleVariant(m)}
                    disabled={busyId === m.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#EEF8F6] text-[#0F766E] text-xs font-semibold hover:bg-[#DCF1ED] cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    生成同类变式题
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
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-50 text-amber-800 text-xs font-semibold hover:bg-amber-100 cursor-pointer"
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                    向助教请教
                  </button>
                </div>

                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-[#8A857C]">掌握自评：</span>
                  {[
                    { r: 1 as const, label: '仍不会', cls: 'bg-red-50 text-red-700 hover:bg-red-100' },
                    { r: 2 as const, label: '较模糊', cls: 'bg-amber-50 text-amber-800 hover:bg-amber-100' },
                    { r: 3 as const, label: '已理解', cls: 'bg-blue-50 text-blue-700 hover:bg-blue-100' },
                    { r: 4 as const, label: '秒懂攻克', cls: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' },
                  ].map((btn) => (
                    <button
                      key={btn.r}
                      onClick={() => handleSM2Review(m, btn.r)}
                      className={`px-2.5 py-1 rounded-lg font-semibold transition cursor-pointer ${btn.cls}`}
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

      {/* Variant Question Modal */}
      {variantModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          onClick={() => setVariantModal(null)}
        >
          <div
            className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-[#EAE6DF] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#EFECE6]">
              <div>
                <h3 className="font-bold text-base text-[#141311]">举一反三 · 同类变式题</h3>
                <p className="text-xs text-[#7A756C]">考点：{variantModal.question.conceptName}</p>
              </div>
              <button onClick={() => setVariantModal(null)} className="p-1.5 rounded-lg text-[#6F6B63]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              <p className="text-sm font-medium text-[#141311] leading-relaxed">{variantModal.question.stem}</p>

              {variantModal.question.options.length > 0 ? (
                <div className="space-y-2">
                  {variantModal.question.options.map((opt, idx) => {
                    const letter = opt.match(/^([A-D])[.、\s]/i)?.[1]?.toUpperCase() || opt;
                    const selected = variantModal.userAnswer === letter;
                    return (
                      <button
                        key={idx}
                        onClick={() => setVariantModal((p) => (p ? { ...p, userAnswer: letter } : null))}
                        className={`w-full text-left px-3.5 py-2.5 rounded-xl border text-xs transition cursor-pointer ${
                          selected
                            ? 'bg-[#F3F5FC] border-[#3B5BDB] font-semibold'
                            : 'bg-[#FAF9F6] border-[#E5E2DC]'
                        }`}
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
                  className="w-full p-3 rounded-xl border border-[#E5E2DC] text-xs"
                />
              )}

              {variantModal.revealed ? (
                <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-1.5 text-xs">
                  <div className="font-bold text-emerald-900">参考答案：{variantModal.question.correctAnswer}</div>
                  <div className="text-emerald-800 leading-relaxed">{variantModal.question.explanation}</div>
                  {variantModal.question.memoryTip && (
                    <div className="text-[#3B5BDB] font-medium pt-1">💡 {variantModal.question.memoryTip}</div>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => setVariantModal((p) => (p ? { ...p, revealed: true } : null))}
                  className="w-full py-2.5 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold cursor-pointer"
                >
                  核对答案与解析
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
