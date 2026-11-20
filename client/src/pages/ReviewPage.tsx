import { useEffect, useState } from 'react';
import {
  BookMarked,
  CheckCircle2,
  Eye,
  Flame,
  Lightbulb,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import { MarkdownView } from '../components/MarkdownView';
import type { Flashcard, Note, ReviewQueueItem } from '../types';

interface ReviewPageProps {
  onRefreshGlobal: () => void;
}

export function ReviewPage({ onRefreshGlobal }: ReviewPageProps) {
  const [tab, setTab] = useState<'queue' | 'manage'>('queue');
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [allCards, setAllCards] = useState<Flashcard[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  // Study session state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [completedToday, setCompletedToday] = useState(0);
  const [lastIntervalMsg, setLastIntervalMsg] = useState('');

  // Create / Generate flashcard state
  const [selectedNoteId, setSelectedNoteId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [newFront, setNewFront] = useState('');
  const [newBack, setNewBack] = useState('');
  const [newHint, setNewHint] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const [qRes, cards, noteList] = await Promise.all([
        api.getReviewQueue(),
        api.getFlashcards(),
        api.getNotes(),
      ]);
      setQueue(qRes.items);
      setAllCards(cards);
      setNotes(noteList);
      if (noteList.length > 0 && !selectedNoteId) setSelectedNoteId(noteList[0].id);
      setCurrentIndex(0);
      setFlipped(false);
      setShowHint(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const currentItem = queue[currentIndex];

  const handleRate = async (rating: 1 | 2 | 3 | 4) => {
    if (!currentItem) return;
    try {
      const res =
        currentItem.itemType === 'flashcard'
          ? await api.reviewFlashcard(currentItem.id, rating)
          : await api.reviewMistake(currentItem.id, rating);

      setLastIntervalMsg(`下次复习：${res.nextLabel}`);
      setCompletedToday((c) => c + 1);
      setFlipped(false);
      setShowHint(false);

      if (rating === 1) {
        // Put "Again" item back at the end of current session queue
        setQueue((prev) => [...prev.slice(0, currentIndex), ...prev.slice(currentIndex + 1), currentItem]);
      } else {
        setQueue((prev) => [...prev.slice(0, currentIndex), ...prev.slice(currentIndex + 1)]);
      }
      onRefreshGlobal();
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Keyboard shortcuts for desktop rapid review
  useEffect(() => {
    if (tab !== 'queue' || !currentItem) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
        handleRate(Number(e.key) as 1 | 2 | 3 | 4);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tab, currentItem, flipped]);

  const handleGenerateCards = async () => {
    if (!selectedNoteId) return;
    setGenerating(true);
    try {
      const res = await api.generateFlashcards(selectedNoteId, 6);
      alert(`已成功生成 ${res.count} 张闪卡并加入今日复习队列！`);
      await loadData();
      onRefreshGlobal();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleManualCreate = async () => {
    if (!newFront.trim() || !newBack.trim()) return;
    await api.createFlashcard({
      front: newFront,
      back: newBack,
      hint: newHint,
      noteId: selectedNoteId || null,
    });
    setNewFront('');
    setNewBack('');
    setNewHint('');
    await loadData();
    onRefreshGlobal();
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#141311]">间隔重复复习与闪卡</h1>
          <p className="text-xs text-[#7A756C] mt-0.5">
            采用 SM-2 艾宾浩斯遗忘曲线调度，统一复习到期闪卡与错题。桌面端支持空格翻面、`1-4` 快捷评分。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setTab('queue')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer ${
              tab === 'queue' ? 'bg-[#1C1B18] text-white' : 'bg-white border border-[#E5E2DC] text-[#524F49]'
            }`}
          >
            <Flame className="w-3.5 h-3.5 text-amber-400" />
            今日复习 ({queue.length})
          </button>
          <button
            onClick={() => setTab('manage')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer ${
              tab === 'manage' ? 'bg-[#1C1B18] text-white' : 'bg-white border border-[#E5E2DC] text-[#524F49]'
            }`}
          >
            <BookMarked className="w-3.5 h-3.5" />
            闪卡库 ({allCards.length})
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-12 text-center text-sm text-[#8A857C]">加载复习计划中...</div>
      ) : tab === 'queue' ? (
        queue.length === 0 ? (
          <div className="max-w-xl mx-auto p-10 rounded-3xl bg-white border border-[#EAE6DF] text-center space-y-3">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
            <h2 className="text-lg font-bold text-[#141311]">太棒了！今日待复习已全部清空</h2>
            <p className="text-xs text-[#7A756C]">
              本次已完成 {completedToday} 项主动回忆巩固。你可以切换至「闪卡库」从笔记一键生成更多闪卡，或去做一套动态测验！
            </p>
            <button
              onClick={() => setTab('manage')}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold cursor-pointer mt-2"
            >
              <Sparkles className="w-4 h-4" />
              去从笔记生成新闪卡
            </button>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-4">
            {/* Progress Header */}
            <div className="flex items-center justify-between text-xs text-[#6F6B63] px-1">
              <span>
                剩余待复习：<strong className="text-[#141311]">{queue.length}</strong> 项 · 已完成 {completedToday} 项
              </span>
              {lastIntervalMsg && <span className="text-[#0F766E] font-medium">{lastIntervalMsg}</span>}
            </div>

            {/* Interactive Flip Card */}
            <div
              onClick={() => !flipped && setFlipped(true)}
              className={`min-h-[320px] sm:min-h-[360px] p-6 sm:p-8 rounded-3xl bg-white border-2 transition shadow-sm flex flex-col justify-between ${
                flipped ? 'border-[#3B5BDB]/40' : 'border-[#EAE6DF] cursor-pointer hover:border-[#3B5BDB]/40'
              }`}
            >
              {/* Card Badges */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${
                      currentItem.itemType === 'mistake'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-[#F3F5FC] text-[#3B5BDB]'
                    }`}
                  >
                    {currentItem.itemType === 'mistake' ? '错题复习' : '记忆闪卡'}
                  </span>
                  {currentItem.concept_name && (
                    <span className="text-xs text-[#7A756C] font-medium">{currentItem.concept_name}</span>
                  )}
                </div>
                {currentItem.note_title && (
                  <span className="text-[11px] text-[#9C978E] truncate max-w-[160px]">{currentItem.note_title}</span>
                )}
              </div>

              {/* Front Question */}
              <div className="my-6 space-y-4">
                <div className="text-base sm:text-lg font-bold text-[#141311] leading-relaxed">
                  {currentItem.itemType === 'flashcard' ? currentItem.front : currentItem.stem}
                </div>

                {currentItem.itemType === 'mistake' && currentItem.options && currentItem.options.length > 0 && (
                  <div className="space-y-1.5 text-xs text-[#4A4741]">
                    {currentItem.options.map((o, i) => (
                      <div key={i} className="px-3 py-2 rounded-xl bg-[#FAF9F6] border border-[#EFECE6]">
                        {o}
                      </div>
                    ))}
                  </div>
                )}

                {!flipped && currentItem.hint && (
                  <div>
                    {showHint ? (
                      <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                        💡 提示：{currentItem.hint}
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowHint(true);
                        }}
                        className="inline-flex items-center gap-1 text-xs text-amber-700 hover:underline cursor-pointer"
                      >
                        <Lightbulb className="w-3.5 h-3.5" /> 查看回忆提示
                      </button>
                    )}
                  </div>
                )}

                {/* Back Answer */}
                {flipped && (
                  <div className="pt-5 border-t border-dashed border-[#DFDBD2] space-y-3">
                    <div className="text-xs font-bold text-[#0F766E] uppercase tracking-wider">参考答案与解析</div>
                    {currentItem.itemType === 'flashcard' ? (
                      <MarkdownView content={currentItem.back || ''} />
                    ) : (
                      <div className="space-y-2 text-sm">
                        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 font-semibold text-emerald-900">
                          正确答案：{currentItem.correct_answer}
                        </div>
                        <div className="text-xs text-[#3D3A35] leading-relaxed">{currentItem.explanation}</div>
                        {currentItem.ai_diagnosis && (
                          <div className="p-3 rounded-xl bg-[#F3F5FC]">
                            <MarkdownView content={currentItem.ai_diagnosis} className="text-xs" />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Reveal Prompt */}
              {!flipped && (
                <button
                  onClick={() => setFlipped(true)}
                  className="w-full py-3.5 rounded-2xl bg-[#1C1B18] text-white font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99] transition"
                >
                  <Eye className="w-4 h-4" />
                  在脑海中回想后，点击翻面核对答案
                </button>
              )}
            </div>

            {/* SM-2 Rating Buttons */}
            {flipped && (
              <div className="grid grid-cols-4 gap-2 sm:gap-3">
                {[
                  { r: 1 as const, label: '重来', sub: '忘了', cls: 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100' },
                  { r: 2 as const, label: '困难', sub: '想很久', cls: 'bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100' },
                  { r: 3 as const, label: '良好', sub: '记得住', cls: 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100' },
                  { r: 4 as const, label: '简单', sub: '秒回忆', cls: 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100' },
                ].map((btn) => (
                  <button
                    key={btn.r}
                    onClick={() => handleRate(btn.r)}
                    className={`py-3 px-2 rounded-2xl border text-center transition active:scale-95 cursor-pointer ${btn.cls}`}
                  >
                    <div className="text-sm font-bold">{btn.label}</div>
                    <div className="text-[11px] opacity-80 mt-0.5">
                      {currentItem.interval_previews?.[btn.r] || btn.sub}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      ) : (
        /* Flashcard Management & Generator */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-5 space-y-4">
            {/* AI Generator Card */}
            <div className="p-5 rounded-2xl bg-white border border-[#EAE6DF] space-y-3">
              <div className="flex items-center gap-1.5 text-sm font-bold text-[#141311]">
                <Sparkles className="w-4 h-4 text-[#3B5BDB]" />
                从笔记一键 AI 制卡
              </div>
              <select
                value={selectedNoteId}
                onChange={(e) => setSelectedNoteId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-[#DDD8CE] bg-[#FAF9F6] text-xs"
              >
                {notes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
              <button
                onClick={handleGenerateCards}
                disabled={generating || !selectedNoteId}
                className="w-full py-2.5 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60 cursor-pointer"
              >
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {generating ? '正在提炼记忆闪卡...' : 'AI 自动生成 6 张闪卡'}
              </button>
            </div>

            {/* Manual Flashcard Creator */}
            <div className="p-5 rounded-2xl bg-white border border-[#EAE6DF] space-y-3">
              <div className="flex items-center gap-1.5 text-sm font-bold text-[#141311]">
                <Plus className="w-4 h-4 text-[#0F766E]" />
                手动新建闪卡
              </div>
              <textarea
                value={newFront}
                onChange={(e) => setNewFront(e.target.value)}
                rows={2}
                placeholder="正面（问题 / 概念 / 挖空句子）"
                className="w-full px-3 py-2 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-xs outline-none focus:border-[#3B5BDB]"
              />
              <textarea
                value={newBack}
                onChange={(e) => setNewBack(e.target.value)}
                rows={3}
                placeholder="背面（精炼答案 / 公式 / 解析）"
                className="w-full px-3 py-2 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-xs outline-none focus:border-[#3B5BDB]"
              />
              <input
                value={newHint}
                onChange={(e) => setNewHint(e.target.value)}
                placeholder="提示词（可选）"
                className="w-full px-3 py-2 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-xs outline-none focus:border-[#3B5BDB]"
              />
              <button
                onClick={handleManualCreate}
                className="w-full py-2.5 rounded-xl bg-[#1C1B18] text-white text-xs font-semibold cursor-pointer"
              >
                添加到闪卡库
              </button>
            </div>
          </div>

          {/* Card List */}
          <div className="lg:col-span-7 space-y-2.5">
            {allCards.length === 0 ? (
              <div className="p-10 rounded-2xl bg-white border border-[#EAE6DF] text-center text-xs text-[#8A857C]">
                暂无闪卡，可在左侧一键从笔记生成或手动创建
              </div>
            ) : (
              allCards.map((c) => (
                <div key={c.id} className="p-4 rounded-2xl bg-white border border-[#EAE6DF] space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-semibold text-[#141311]">{c.front}</div>
                    <button
                      onClick={async () => {
                        await api.deleteFlashcard(c.id);
                        loadData();
                        onRefreshGlobal();
                      }}
                      className="p-1 text-[#9C978E] hover:text-red-600 shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="text-xs text-[#524F49] bg-[#FAF9F6] p-3 rounded-xl whitespace-pre-wrap">{c.back}</div>
                  <div className="flex items-center justify-between text-[11px] text-[#8A857C]">
                    <span>{c.concept_name || c.note_title || '通用闪卡'}</span>
                    <span>
                      已复习 {c.repetitions} 次 · 下次：{new Date(c.next_review_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
