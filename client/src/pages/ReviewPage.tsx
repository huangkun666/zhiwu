import React, { useEffect, useRef, useState } from 'react';
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

  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [completedToday, setCompletedToday] = useState(0);
  const [lastIntervalMsg, setLastIntervalMsg] = useState('');

  // Touch swipe state for mobile single-hand flashcard review
  const touchStartX = useRef<number | null>(null);
  const [swipeDx, setSwipeDx] = useState(0);

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
      setSelectedNoteId((current) => noteList.some(({ id }) => id === current) ? current : noteList[0]?.id || '');
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
      setSwipeDx(0);

      if (rating === 1) {
        setQueue((prev) => [...prev.slice(0, currentIndex), ...prev.slice(currentIndex + 1), currentItem]);
      } else {
        setQueue((prev) => [...prev.slice(0, currentIndex), ...prev.slice(currentIndex + 1)]);
      }
      onRefreshGlobal();
    } catch (e: any) {
      alert(e.message);
    }
  };

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

  const onTouchStart = (e: React.TouchEvent) => {
    if (!flipped) return;
    touchStartX.current = e.touches[0].clientX;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null || !flipped) return;
    const dx = e.touches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 12) setSwipeDx(Math.max(-120, Math.min(120, dx)));
  };
  const onTouchEnd = () => {
    if (touchStartX.current === null) return;
    if (swipeDx > 78) handleRate(3);
    else if (swipeDx < -78) handleRate(1);
    else setSwipeDx(0);
    touchStartX.current = null;
  };

  const handleGenerateCards = async () => {
    if (!selectedNoteId) return;
    setGenerating(true);
    try {
      const res = await api.generateFlashcards(selectedNoteId, 6);
      alert(`已生成 ${res.count} 张闪卡并加入今日复习队列`);
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
    try {
      await api.createFlashcard({ front: newFront, back: newBack, hint: newHint, noteId: selectedNoteId || null });
      setNewFront('');
      setNewBack('');
      setNewHint('');
      await loadData();
      onRefreshGlobal();
    } catch (error) {
      alert(error instanceof Error ? error.message : '创建闪卡失败');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">复习与闪卡</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            SM-2 遗忘曲线调度 · 翻面后支持左滑「忘了」/ 右滑「记得」或键盘 1–4 评分。
          </p>
        </div>
        <div
          className="inline-flex p-1 rounded-xl border self-start"
          style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
        >
          <button
            onClick={() => setTab('queue')}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer transition"
            style={{
              background: tab === 'queue' ? 'var(--bg-card-solid)' : 'transparent',
              color: tab === 'queue' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            <Flame className="w-3.5 h-3.5" />
            今日队列 ({queue.length})
          </button>
          <button
            onClick={() => setTab('manage')}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer transition"
            style={{
              background: tab === 'manage' ? 'var(--bg-card-solid)' : 'transparent',
              color: tab === 'manage' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            <BookMarked className="w-3.5 h-3.5" />
            闪卡库 ({allCards.length})
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-12 text-center text-xs text-[var(--text-muted)]">加载中...</div>
      ) : tab === 'queue' ? (
        queue.length === 0 ? (
          <div className="max-w-xl mx-auto p-10 rounded-3xl zw-card text-center space-y-3">
            <CheckCircle2 className="w-10 h-10 mx-auto" style={{ color: 'var(--ok-fg)' }} />
            <h2 className="text-base font-semibold">今日待复习已全部清空</h2>
            <p className="text-xs text-[var(--text-muted)]">
              本次已完成 {completedToday} 项主动回忆巩固。可前往闪卡库从笔记生成更多卡片。
            </p>
            <button
              onClick={() => setTab('manage')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer mt-2"
            >
              <Sparkles className="w-3.5 h-3.5" />
              生成新闪卡
            </button>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)] px-1">
              <span className="tabular-nums">
                剩余 <strong className="text-[var(--text-primary)]">{queue.length}</strong> · 已完成 {completedToday}
              </span>
              {lastIntervalMsg && <span style={{ color: 'var(--ok-fg)' }}>{lastIntervalMsg}</span>}
            </div>

            {/* Swipeable Frosted Flip Card */}
            <div
              onClick={() => !flipped && setFlipped(true)}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              className={`min-h-[320px] sm:min-h-[360px] p-6 sm:p-8 rounded-3xl zw-card flex flex-col justify-between transition-transform ${
                flipped ? '' : 'cursor-pointer hover:border-[var(--border-strong)]'
              }`}
              style={{
                transform: swipeDx ? `translateX(${swipeDx}px) rotate(${swipeDx * 0.03}deg)` : undefined,
                borderColor:
                  swipeDx > 40 ? 'var(--ok-border)' : swipeDx < -40 ? 'var(--danger-border)' : undefined,
              }}
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-2">
                  <span
                    className="px-2 py-0.5 rounded-md font-medium"
                    style={
                      currentItem.itemType === 'mistake'
                        ? { background: 'var(--danger-bg)', color: 'var(--danger-fg)' }
                        : { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }
                    }
                  >
                    {currentItem.itemType === 'mistake' ? '错题复习' : '记忆闪卡'}
                  </span>
                  {currentItem.concept_name && (
                    <span className="text-[var(--text-muted)]">{currentItem.concept_name}</span>
                  )}
                </div>
                {swipeDx > 40 ? (
                  <span className="font-semibold" style={{ color: 'var(--ok-fg)' }}>
                    松手记为「良好」→
                  </span>
                ) : swipeDx < -40 ? (
                  <span className="font-semibold" style={{ color: 'var(--danger-fg)' }}>
                    ← 松手记为「重来」
                  </span>
                ) : (
                  currentItem.note_title && (
                    <span className="text-[var(--text-muted)] truncate max-w-[160px]">{currentItem.note_title}</span>
                  )
                )}
              </div>

              <div className="my-6 space-y-4">
                <div className="text-base sm:text-lg font-semibold leading-relaxed">
                  {currentItem.itemType === 'flashcard' ? currentItem.front : currentItem.stem}
                </div>

                {currentItem.itemType === 'mistake' && currentItem.options && currentItem.options.length > 0 && (
                  <div className="space-y-1.5 text-xs text-[var(--text-secondary)]">
                    {currentItem.options.map((o, i) => (
                      <div
                        key={i}
                        className="px-3 py-2 rounded-xl border"
                        style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
                      >
                        {o}
                      </div>
                    ))}
                  </div>
                )}

                {!flipped && currentItem.hint && (
                  <div>
                    {showHint ? (
                      <div
                        className="p-3 rounded-xl border text-xs"
                        style={{ background: 'var(--warn-bg)', borderColor: 'var(--warn-border)', color: 'var(--warn-fg)' }}
                      >
                        提示：{currentItem.hint}
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowHint(true);
                        }}
                        className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        <Lightbulb className="w-3.5 h-3.5" /> 查看提示
                      </button>
                    )}
                  </div>
                )}

                {flipped && (
                  <div className="pt-5 border-t space-y-3" style={{ borderColor: 'var(--border-hairline)' }}>
                    <div className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                      参考答案
                    </div>
                    {currentItem.itemType === 'flashcard' ? (
                      <MarkdownView content={currentItem.back || ''} />
                    ) : (
                      <div className="space-y-2 text-sm">
                        <div
                          className="p-3 rounded-xl border font-semibold text-xs"
                          style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok-border)', color: 'var(--ok-fg)' }}
                        >
                          正确答案：{currentItem.correct_answer}
                        </div>
                        <div className="text-xs text-[var(--text-secondary)] leading-relaxed">
                          {currentItem.explanation}
                        </div>
                        {currentItem.ai_diagnosis && (
                          <div className="p-3 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
                            <MarkdownView content={currentItem.ai_diagnosis} className="text-xs" />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!flipped && (
                <button
                  onClick={() => setFlipped(true)}
                  className="w-full py-3 rounded-2xl zw-btn-primary font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Eye className="w-4 h-4" />
                  回忆后点击翻面
                </button>
              )}
            </div>

            {flipped && (
              <div className="grid grid-cols-4 gap-2 sm:gap-2.5">
                {[
                  { r: 1 as const, label: '重来', sub: '忘了' },
                  { r: 2 as const, label: '困难', sub: '想很久' },
                  { r: 3 as const, label: '良好', sub: '记得' },
                  { r: 4 as const, label: '简单', sub: '秒答' },
                ].map((btn) => (
                  <button
                    key={btn.r}
                    onClick={() => handleRate(btn.r)}
                    className="py-3 px-2 rounded-2xl zw-card hover:border-[var(--border-strong)] text-center transition active:scale-95 cursor-pointer"
                  >
                    <div className="text-xs font-semibold">{btn.label}</div>
                    <div className="text-[10px] text-[var(--text-muted)] mt-0.5 tabular-nums">
                      {currentItem.interval_previews?.[btn.r] || btn.sub}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-5 space-y-4">
            <div className="p-5 rounded-2xl zw-card space-y-3">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <Sparkles className="w-4 h-4" />
                从笔记一键制卡
              </div>
              <select
                value={selectedNoteId}
                onChange={(e) => setSelectedNoteId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl zw-input text-xs"
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
                className="w-full py-2.5 rounded-xl zw-btn-primary text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {generating ? '生成中...' : 'AI 生成 6 张闪卡'}
              </button>
            </div>

            <div className="p-5 rounded-2xl zw-card space-y-3">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <Plus className="w-4 h-4" />
                手动新建闪卡
              </div>
              <textarea
                value={newFront}
                onChange={(e) => setNewFront(e.target.value)}
                rows={2}
                placeholder="正面（问题 / 概念）"
                className="w-full px-3 py-2 rounded-xl zw-input text-xs"
              />
              <textarea
                value={newBack}
                onChange={(e) => setNewBack(e.target.value)}
                rows={3}
                placeholder="背面（精炼答案）"
                className="w-full px-3 py-2 rounded-xl zw-input text-xs"
              />
              <input
                value={newHint}
                onChange={(e) => setNewHint(e.target.value)}
                placeholder="提示词（可选）"
                className="w-full px-3 py-2 rounded-xl zw-input text-xs"
              />
              <button
                onClick={handleManualCreate}
                className="w-full py-2.5 rounded-xl zw-btn-secondary text-xs font-semibold cursor-pointer"
              >
                添加闪卡
              </button>
            </div>
          </div>

          <div className="lg:col-span-7 space-y-2.5">
            {allCards.length === 0 ? (
              <div className="p-10 rounded-2xl zw-card text-center text-xs text-[var(--text-muted)]">
                暂无闪卡
              </div>
            ) : (
              allCards.map((c) => (
                <div key={c.id} className="p-4 rounded-2xl zw-card space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium">{c.front}</div>
                    <button
                      onClick={async () => {
                        await api.deleteFlashcard(c.id);
                        loadData();
                        onRefreshGlobal();
                      }}
                      className="p-1 text-[var(--text-muted)] hover:text-[var(--danger-fg)] shrink-0 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div
                    className="text-xs text-[var(--text-secondary)] p-3 rounded-xl whitespace-pre-wrap"
                    style={{ background: 'var(--bg-subtle)' }}
                  >
                    {c.back}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] tabular-nums">
                    <span>{c.concept_name || c.note_title || '通用闪卡'}</span>
                    <span>
                      已复习 {c.repetitions} 次 · 下次 {new Date(c.next_review_at).toLocaleDateString()}
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
