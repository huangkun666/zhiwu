import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookMarked,
  BookOpen,
  ChevronDown,
  FilePlus2,
  History,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { api } from '../api/client';
import { existingIds } from '../../../server/src/shared/libraryReferences';
import { tutorModeLabels, tutorOpeningMode } from '../../../server/src/shared/tutorMode';
import { MarkdownView } from '../components/MarkdownView';
import { TutorHistory } from '../components/TutorHistory';
import { TutorModeDialog } from '../components/TutorModeDialog';
import { useTutorHistory } from './useTutorHistory';
import type { Note, TutorMessage, TutorMode, TutorSession } from '../types';

interface NewSessionOptions {
  mode?: TutorMode;
  noteIds?: string[];
  title?: string;
  initialPrompt?: string;
}

interface TutorPageProps {
  initialContext?: NewSessionOptions & {
    sessionId?: string;
    scrollTop?: number;
  } | null;
  onRefreshGlobal?: () => void;
  onOpenCitation: (href: string, sessionId: string, chatScrollTop: number) => void;
  onSessionChange: (id: string | null) => void;
}

type NoteAppend = { noteId: string; excerptId: string };

export function TutorPage({ initialContext, onRefreshGlobal, onOpenCitation, onSessionChange }: TutorPageProps) {
  const history = useTutorHistory();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modeDialog, setModeDialog] = useState<'create' | 'settings' | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeSession, setActiveSession] = useState<TutorSession | null>(null);
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const mode = activeSession?.mode ?? 'general';
  const openingMode = messages[0]?.role === 'assistant' && tutorOpeningMode(messages[0].content);
  const visibleMessages = openingMode && openingMode !== mode ? messages.slice(1) : messages;
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [discardedNoteIds, setDiscardedNoteIds] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [retrievalStatus, setRetrievalStatus] = useState('');
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [toast, setToast] = useState<{ message: string; append?: NoteAppend } | null>(null);
  const [noteActionBusy, setNoteActionBusy] = useState(false);
  const conversationRef = useRef<HTMLDivElement>(null);
  const restoreScrollTop = useRef(initialContext?.scrollTop);
  const sessionRequest = useRef(0);
  const activeId = useRef<string | null>(null);
  const openingId = useRef<string | null>(null);
  const pendingSend = useRef<symbol | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const noteRequest = useRef(0);
  const availableSelection = useMemo(
    () => mode === 'general' ? [] : existingIds(selectedNoteIds, new Set(notes.map(({ id }) => id))),
    [mode, selectedNoteIds, notes]
  );
  const referenceCount = selectedNoteIds.length ? availableSelection.length : notes.length ? '自动' : 0;

  const showToast = (message: string, append?: NoteAppend) => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, append });
    toastTimer.current = window.setTimeout(() => setToast(null), append ? 8000 : 2800);
  };

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const refreshContextNotes = async () => {
    const request = ++noteRequest.current;
    try {
      const list = await api.getNotes();
      if (request === noteRequest.current) setNotes(list);
    } catch {
      // Keep the last successfully loaded list if the note library is unreachable.
    }
  };

  const resetReply = () => {
    pendingSend.current = null;
    setSending(false);
    setStreamingText('');
    setRetrievalStatus('');
  };

  const displaySession = (session: TutorSession, savedMessages: TutorMessage[]) => {
    resetReply();
    activeId.current = session.id;
    setActiveSession(session);
    onSessionChange(session.id);
    setMessages(savedMessages);
    setSelectedNoteIds(session.selection_ids ?? session.note_ids ?? []);
    setDiscardedNoteIds([]);
    setInput('');
    setShowContextPicker(false);
  };

  const openSession = async (id: string, request = ++sessionRequest.current) => {
    openingId.current = id;
    if (activeId.current === id) return;
    const res = await api.getTutorMessages(id);
    if (request === sessionRequest.current) displaySession(res.session, res.messages);
  };

  const selectSession = async (id: string) => {
    const request = ++sessionRequest.current;
    await openSession(id, request);
    if (request === sessionRequest.current) setHistoryOpen(false);
  };

  const startNewSession = async (opts: NewSessionOptions) => {
    const request = ++sessionRequest.current;
    openingId.current = null;
    const sess = await api.createTutorSession({
      ...opts,
      mode: opts.mode ?? 'general',
    });
    void history.refresh();
    if (request !== sessionRequest.current) return;
    if (sess.mode === 'general') {
      displaySession(sess, []);
    } else {
      try {
        await openSession(sess.id, request);
      } catch {
        if (request !== sessionRequest.current) return;
        // Creation already succeeded. Keep this session if reading the opening message fails.
        displaySession(sess, []);
        showToast('对话已创建，暂时无法加载开场消息');
      }
    }
    if (request === sessionRequest.current) {
      setHistoryOpen(false);
      if (opts.initialPrompt) setInput(opts.initialPrompt);
    }
  };

  const confirmMode = async (next: TutorMode) => {
    if (modeDialog === 'create') {
      await startNewSession({ mode: next });
    } else if (activeSession && next !== mode) {
      const updated = await api.setTutorSessionMode(activeSession.id, next);
      if (activeId.current === updated.id) {
        setActiveSession(s => s?.id === updated.id ? { ...s, mode: updated.mode, updated_at: updated.updated_at } : s);
        setShowContextPicker(false);
      }
      void history.refreshAfterEdit(updated.id, updated);
    }
    setModeDialog(null);
  };

  const renameSession = async (id: string, title: string) => {
    const updated = await api.renameTutorSession(id, title);
    setActiveSession(session => session?.id === id ? { ...session, title: updated.title, updated_at: updated.updated_at } : session);
    await history.refreshAfterEdit(id, updated);
  };

  const deleteSession = async (id: string) => {
    await api.deleteTutorSession(id);
    if (openingId.current === id) {
      ++sessionRequest.current;
      openingId.current = null;
    }
    if (activeId.current === id) {
      activeId.current = null;
      resetReply();
      setActiveSession(null);
      onSessionChange(null);
      setMessages([]);
      setInput('');
      setSelectedNoteIds([]);
      setDiscardedNoteIds([]);
      setShowContextPicker(false);
    }
    await history.refreshAfterEdit(id);
  };

  useEffect(() => {
    const request = sessionRequest.current;
    const firstPage = history.refresh();
    void Promise.resolve().then(async () => {
      if (request !== sessionRequest.current) return;
      if (initialContext?.sessionId) await openSession(initialContext.sessionId);
      else if (initialContext) await startNewSession(initialContext);
      else {
        const rows = await firstPage;
        if (request === sessionRequest.current && rows?.length) await openSession(rows[0].id);
      }
    }).catch(e => showToast(e.message || '无法打开对话'));
    return () => {
      ++sessionRequest.current;
      activeId.current = null;
      openingId.current = null;
      pendingSend.current = null;
    };
  }, []);

  useEffect(() => {
    if (mode !== 'general') void refreshContextNotes();
  }, [mode, activeSession?.id]);

  useEffect(() => {
    const panel = conversationRef.current;
    if (!panel || !messages.length) return;
    panel.scrollTop = restoreScrollTop.current ?? panel.scrollHeight;
    restoreScrollTop.current = undefined;
  }, [messages, streamingText, sending]);

  const handleSend = async (customText?: string) => {
    const text = (customText ?? input).trim();
    if (!text || pendingSend.current) return;
    const request = Symbol();
    pendingSend.current = request;
    setSending(true);
    setRetrievalStatus('');
    setStreamingText('');
    let session = activeSession;
    try {
      if (!session) {
        const opening = ++sessionRequest.current;
        openingId.current = null;
        const created = await api.createTutorSession({ mode, title: text.slice(0, 22) });
        void history.refresh();
        if (pendingSend.current !== request || opening !== sessionRequest.current) return;
        activeId.current = created.id;
        setActiveSession(created);
        onSessionChange(created.id);
        session = created;
      }
      const optimisticUser: TutorMessage = {
        id: `temp-${Date.now()}`, session_id: session.id,
        role: 'user', content: text, created_at: new Date().toISOString(),
      };
      setInput('');
      setMessages((prev) => [...prev, optimisticUser]);
      const res = await api.sendTutorMessageStream(
        session.id,
        mode === 'general' ? { message: text, mode } : { message: text, mode, noteIds: selectedNoteIds, discardedNoteIds },
        (delta) => { if (pendingSend.current === request) setStreamingText((prev) => prev + delta); },
        (status) => { if (pendingSend.current === request) setRetrievalStatus(status); },
      );
      void history.refresh();
      if (activeId.current !== session.id) return;
      if (pendingSend.current === request) {
        if (mode !== 'general') setDiscardedNoteIds(prev => prev.filter(id => !discardedNoteIds.includes(id)));
        setStreamingText('');
      }
      setMessages(prev => prev.some(m => m.id === res.assistantMessage.id) ? prev
        : [...prev.filter(m => m.id !== optimisticUser.id), res.userMessage, res.assistantMessage]);
    } catch (e: any) {
      if (pendingSend.current !== request) return;
      if (!session) { showToast(e.message || '无法新建对话'); return; }
      setStreamingText('');
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          session_id: session!.id,
          role: 'assistant',
          content: `> **提示**：${e.message || '助教暂时无法回复，请检查「设置」中的模型配置。'}`,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      if (pendingSend.current === request) {
        pendingSend.current = null;
        setSending(false);
      }
    }
  };

  // Closed-loop沉淀: Save an AI reply directly as a Flashcard
  const handleSaveAsFlashcard = async (msgIndex: number) => {
    const aiMsg = visibleMessages[msgIndex];
    const prevUser = [...visibleMessages.slice(0, msgIndex)].reverse().find((m) => m.role === 'user');
    const front = prevUser?.content?.slice(0, 140) || activeSession?.title || '对话要点';
    try {
      await api.createFlashcard({
        front,
        back: aiMsg.content.slice(0, 1200),
        noteId: availableSelection[0] || null,
        conceptName: activeSession?.title || '助教沉淀',
      });
      onRefreshGlobal?.();
      showToast('已一键存为记忆闪卡，加入复习计划！');
    } catch (e: any) {
      refreshContextNotes();
      alert(e.message);
    }
  };

  // Closed-loop沉淀: Append AI insight back into linked note (or create a new note)
  const handleAppendToNote = async (message: TutorMessage) => {
    if (noteActionBusy) return;
    setNoteActionBusy(true);
    try {
      const targetNoteId = availableSelection[0];
      if (targetNoteId) {
        const note = await api.appendNoteChat(targetNoteId, message.id, message.content);
        showToast(`已追加到《${note.title}》`, { noteId: note.id, excerptId: message.id });
      } else {
        await api.createNote({
          title: `助教沉淀：${activeSession?.title || '学习思考'}`,
          content: message.content,
          tags: [mode === 'feynman' ? '费曼沉淀' : '对话摘录'],
        });
        showToast('已保存为新笔记');
      }
      onRefreshGlobal?.();
    } catch (e: any) {
      refreshContextNotes();
      alert(e.message);
    } finally {
      setNoteActionBusy(false);
    }
  };

  const handleUndoAppend = async (append: NoteAppend) => {
    if (noteActionBusy) return;
    setNoteActionBusy(true);
    try {
      await api.removeNoteChat(append.noteId, append.excerptId);
      onRefreshGlobal?.();
      showToast('已撤销聊天追加');
    } catch (error) {
      alert(error instanceof Error ? error.message : '无法撤销聊天追加');
    } finally {
      setNoteActionBusy(false);
    }
  };

  const quickPrompts =
    mode === 'feynman'
      ? ['给我出一道追问，检验我是否真懂了', '我用大白话复述一遍，你帮我挑刺打分', '这个概念最容易在什么边界条件下误用？']
      : ['用生活类比帮我讲透核心原理', '提炼这份笔记最易混淆的 3 个考点', '这些知识实际怎么用？'];

  return (
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-12 lg:gap-4">
      {toast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-3 max-w-[calc(100vw-2rem)] px-4 py-2.5 rounded-xl zw-btn-primary text-xs font-medium shadow-lg">
          <span role="status" className="break-words min-w-0">{toast.message}</span>
          {toast.append && (
            <button
              type="button"
              disabled={noteActionBusy}
              onClick={() => handleUndoAppend(toast.append!)}
              className="shrink-0 flex items-center gap-1 rounded-lg border border-current px-2 py-1 cursor-pointer disabled:opacity-50"
            >
              <Undo2 className="w-3.5 h-3.5" /> 撤销
            </button>
          )}
        </div>
      )}

      <TutorHistory history={history} activeId={activeSession?.id}
        mobileOpen={historyOpen} onClose={() => setHistoryOpen(false)}
        onSelect={selectSession} onRename={renameSession} onDelete={deleteSession} />
      {modeDialog && (
        <TutorModeDialog kind={modeDialog} initialMode={modeDialog === 'create' ? 'general' : mode}
          onConfirm={confirmMode} onClose={() => setModeDialog(null)} />
      )}

      {/* Chat Area */}
      <div className="lg:col-span-9 flex min-h-0 min-w-0 flex-col md:rounded-2xl zw-card max-md:border-0 overflow-hidden">
        <div
          className="shrink-0 px-2 py-2 sm:px-4 sm:py-3 border-b flex flex-wrap items-center justify-between gap-1"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            {activeSession ? (
              <button type="button" aria-label="对话设置" title="对话设置" aria-haspopup="dialog"
                aria-expanded={modeDialog === 'settings'} aria-controls="tutor-mode-dialog"
                onClick={() => setModeDialog('settings')}
                className="zw-btn-secondary inline-flex min-h-9 items-center gap-1 rounded-xl px-1.5 text-xs sm:px-3">
                {tutorModeLabels[mode]}<ChevronDown className="size-3" aria-hidden="true" />
              </button>
            ) : <span className="px-1 text-sm font-medium">{tutorModeLabels.general}</span>}
            {mode !== 'general' && (
              <button type="button" onClick={() => {
                setShowContextPicker(!showContextPicker);
                if (!showContextPicker) void refreshContextNotes();
              }}
                aria-expanded={showContextPicker} aria-label={`参考笔记 (${referenceCount})`}
                className="zw-btn-secondary inline-flex min-h-9 items-center gap-1 rounded-xl px-1.5 text-xs sm:px-3">
                <BookOpen className="hidden size-3.5 sm:block" aria-hidden="true" />
                <span>参考<span className="hidden min-[390px]:inline">笔记</span> ({referenceCount})</span>
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <button type="button" aria-haspopup="dialog" aria-controls="tutor-history" aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(true)}
              className="zw-btn-secondary inline-flex min-h-9 items-center gap-1 rounded-xl px-1.5 text-xs sm:px-3 lg:hidden">
              <History className="hidden size-3.5 min-[420px]:block" aria-hidden="true" />历史对话
            </button>
            <button type="button" aria-haspopup="dialog" aria-controls="tutor-mode-dialog" aria-expanded={modeDialog === 'create'}
              onClick={() => setModeDialog('create')}
              className="zw-btn-primary inline-flex min-h-9 items-center gap-1 rounded-xl px-2 text-xs font-medium sm:px-3">
              <Plus className="hidden size-3.5 min-[390px]:block" aria-hidden="true" />新建对话
            </button>
          </div>
        </div>

        {mode !== 'general' && showContextPicker && (
          <div
            className="px-4 py-3 border-b max-h-36 overflow-y-auto"
            style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
          >
            <div className="text-[11px] text-[var(--text-muted)] mb-2">
              {notes.length ? '勾选后只检索所选笔记，留空则按问题从笔记库查找。' : '笔记库暂无可参考的笔记。'}
            </div>
            {selectedNoteIds.length > availableSelection.length && (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                部分所选笔记已不可用
                <button type="button" onClick={() => {
                  setDiscardedNoteIds(p => [...new Set([...p, ...selectedNoteIds.filter(id => !availableSelection.includes(id))])]);
                  setSelectedNoteIds(availableSelection);
                }}
                  className="rounded-lg zw-btn-secondary px-2 py-1">移除失效选择</button>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {notes.map((n) => {
                const active = availableSelection.includes(n.id);
                return (
                  <button
                    key={n.id}
                    onClick={() =>
                      setSelectedNoteIds((p) => (p.includes(n.id) ? p.filter((x) => x !== n.id) : [...p, n.id]))
                    }
                    className="px-2.5 py-1 rounded-lg text-xs border transition cursor-pointer"
                    style={{
                      background: active ? 'var(--btn-primary-bg)' : 'var(--bg-card-solid)',
                      color: active ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                      borderColor: active ? 'transparent' : 'var(--border-hairline)',
                    }}
                  >
                    {n.title}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div ref={conversationRef} role="region" aria-label="对话消息" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-3 sm:p-5 space-y-4">
          {visibleMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-2.5 py-8">
              <Sparkles className="w-7 h-7 text-[var(--text-muted)]" />
              <h3 className="font-semibold text-sm">
                {mode === 'general' ? '有什么想了解的？' : mode === 'feynman' ? '试着用自己的话解释一个概念' : '想讨论笔记里的哪个问题？'}
              </h3>
            </div>
          ) : (
            visibleMessages.map((m, idx) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`min-w-0 ${m.role === 'assistant' ? 'max-w-full' : 'max-w-[90%]'} sm:max-w-[78%] space-y-1.5`}>
                  <div
                    className={`rounded-2xl px-3 sm:px-4 py-3 text-sm break-words ${
                      m.role === 'user' ? 'zw-btn-primary rounded-br-md' : 'border rounded-bl-md'
                    }`}
                    style={
                      m.role === 'assistant'
                        ? { background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }
                        : undefined
                    }
                  >
                    {m.role === 'user' ? (
                      <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
                    ) : (
                      <MarkdownView content={m.content} className="text-sm"
                        onOpenNote={(href) => onOpenCitation(href, m.session_id, conversationRef.current?.scrollTop ?? 0)} />
                    )}
                  </div>
                  {/* Closed-loop沉淀 actions on AI messages */}
                  {m.role === 'assistant' && idx > 0 && (
                    <div className="flex items-center gap-2 pl-1 text-[11px] text-[var(--text-muted)]">
                      <button
                        onClick={() => handleSaveAsFlashcard(idx)}
                        className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] cursor-pointer transition"
                      >
                        <BookMarked className="w-3 h-3" /> 存为闪卡
                      </button>
                      <span>·</span>
                      <button
                        onClick={() => handleAppendToNote(m)}
                        disabled={noteActionBusy}
                        className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] cursor-pointer transition disabled:opacity-50"
                      >
                        <FilePlus2 className="w-3 h-3" /> {availableSelection.length ? '追加到笔记' : '存为新笔记'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {/* Live Streaming Assistant Bubble */}
          {sending && (
            <div className="flex justify-start">
              <div
                className="min-w-0 max-w-full sm:max-w-[78%] rounded-2xl rounded-bl-md px-3 sm:px-4 py-3 border text-sm"
                style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
              >
                {streamingText ? (
                  <MarkdownView content={streamingText} className="text-sm" />
                ) : (
                  <span className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {retrievalStatus || '思考中…'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div
          className="shrink-0 p-2 sm:p-4 border-t space-y-2"
          style={{ borderColor: 'var(--border-hairline)', background: 'var(--bg-subtle)' }}
        >
          {mode !== 'general' && (visibleMessages.length === 0 || (visibleMessages.length === 1 && visibleMessages[0].role === 'assistant')) && (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {quickPrompts.map((qp, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(qp)}
                  className="shrink-0 px-3 py-1.5 rounded-full zw-btn-secondary text-[11px] cursor-pointer"
                >
                  {qp}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={1}
              placeholder={
                mode === 'general' ? '输入你的问题…' : mode === 'feynman' ? '用自己的话解释一个概念…' : '输入想请教的问题…'
              }
              className="min-w-0 min-h-11 max-h-28 sm:min-h-14 field-sizing-content flex-1 px-3 py-2 rounded-xl zw-input text-base sm:text-sm resize-none"
            />
            <button
              onClick={() => handleSend()}
              aria-label="发送消息"
              disabled={sending || !input.trim()}
              className="p-3 rounded-xl zw-btn-primary disabled:opacity-45 cursor-pointer shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
