import { useEffect, useRef, useState } from 'react';
import {
  BookMarked,
  BookOpen,
  FilePlus2,
  GraduationCap,
  Loader2,
  MessageSquareText,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react';
import { api } from '../api/client';
import { MarkdownView } from '../components/MarkdownView';
import type { Note, TutorMessage, TutorSession } from '../types';

interface TutorPageProps {
  initialContext?: {
    mode?: 'qa' | 'feynman';
    noteIds?: string[];
    title?: string;
    initialPrompt?: string;
  } | null;
  onRefreshGlobal?: () => void;
}

type NoteAppend = { noteId: string; excerptId: string };

export function TutorPage({ initialContext, onRefreshGlobal }: TutorPageProps) {
  const [sessions, setSessions] = useState<TutorSession[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeSession, setActiveSession] = useState<TutorSession | null>(null);
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [mode, setMode] = useState<'qa' | 'feynman'>('feynman');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [toast, setToast] = useState<{ message: string; append?: NoteAppend } | null>(null);
  const [noteActionBusy, setNoteActionBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = (message: string, append?: NoteAppend) => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, append });
    toastTimer.current = window.setTimeout(() => setToast(null), append ? 8000 : 2800);
  };

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const loadSessions = async () => {
    const [sessList, noteList] = await Promise.all([api.getTutorSessions(), api.getNotes()]);
    setSessions(sessList);
    setNotes(noteList);
    return { sessList, noteList };
  };

  const openSession = async (id: string) => {
    const res = await api.getTutorMessages(id);
    setActiveSession(res.session);
    setMessages(res.messages);
    setMode(res.session.mode);
    setSelectedNoteIds(res.session.note_ids || []);
  };

  const startNewSession = async (opts?: {
    mode?: 'qa' | 'feynman';
    noteIds?: string[];
    title?: string;
    initialPrompt?: string;
  }) => {
    const targetMode = opts?.mode || mode;
    const sess = await api.createTutorSession({
      mode: targetMode,
      noteIds: opts?.noteIds || selectedNoteIds,
      title: opts?.title,
      initialPrompt: opts?.initialPrompt,
    });
    setSessions((p) => [sess, ...p]);
    await openSession(sess.id);
    if (opts?.initialPrompt) setInput(opts.initialPrompt);
  };

  useEffect(() => {
    loadSessions().then(({ sessList }) => {
      if (initialContext) startNewSession(initialContext);
      else if (sessList.length > 0) openSession(sessList[0].id);
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, sending]);

  const handleSend = async (customText?: string) => {
    const text = (customText ?? input).trim();
    if (!text || sending) return;

    let session = activeSession;
    if (!session) {
      session = await api.createTutorSession({ mode, noteIds: selectedNoteIds, title: text.slice(0, 22) });
      setSessions((p) => [session!, ...p]);
      setActiveSession(session);
    }

    setInput('');
    setSending(true);
    setStreamingText('');

    const optimisticUser: TutorMessage = {
      id: `temp-${Date.now()}`,
      session_id: session.id,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);

    try {
      const res = await api.sendTutorMessageStream(
        session.id,
        { message: text, noteIds: selectedNoteIds, mode },
        (delta) => setStreamingText((prev) => prev + delta)
      );
      setStreamingText('');
      setMessages((prev) => [...prev.filter((m) => m.id !== optimisticUser.id), res.userMessage, res.assistantMessage]);
    } catch (e: any) {
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
      setSending(false);
    }
  };

  // Closed-loop沉淀: Save an AI reply directly as a Flashcard
  const handleSaveAsFlashcard = async (msgIndex: number) => {
    const aiMsg = messages[msgIndex];
    const prevUser = [...messages.slice(0, msgIndex)].reverse().find((m) => m.role === 'user');
    const front = prevUser?.content?.slice(0, 140) || activeSession?.title || '费曼对话要点';
    try {
      await api.createFlashcard({
        front,
        back: aiMsg.content.slice(0, 1200),
        noteId: selectedNoteIds[0] || null,
        conceptName: activeSession?.title || '助教沉淀',
      });
      onRefreshGlobal?.();
      showToast('已一键存为记忆闪卡，加入复习计划！');
    } catch (e: any) {
      alert(e.message);
    }
  };

  // Closed-loop沉淀: Append AI insight back into linked note (or create a new note)
  const handleAppendToNote = async (message: TutorMessage) => {
    if (noteActionBusy) return;
    setNoteActionBusy(true);
    try {
      const targetNoteId = selectedNoteIds[0];
      if (targetNoteId) {
        const note = await api.appendNoteChat(targetNoteId, message.id, message.content);
        showToast(`已追加到《${note.title}》`, { noteId: note.id, excerptId: message.id });
      } else {
        await api.createNote({
          title: `助教沉淀：${activeSession?.title || '学习思考'}`,
          content: message.content,
          tags: ['费曼沉淀'],
        });
        showToast('已保存为新笔记');
      }
      onRefreshGlobal?.();
    } catch (e: any) {
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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-[calc(100dvh-8.2rem)] md:h-[calc(100vh-4.5rem)]">
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

      {/* Sessions Sidebar */}
      <div className="hidden lg:flex lg:col-span-3 flex-col rounded-2xl zw-card overflow-hidden">
        <div
          className="p-3 border-b space-y-2"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <button
            onClick={() => startNewSession({ mode: 'feynman' })}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
          >
            <GraduationCap className="w-3.5 h-3.5" />
            新建费曼考官
          </button>
          <button
            onClick={() => startNewSession({ mode: 'qa' })}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            新建笔记答疑
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => openSession(s.id)}
              className="group flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-xs cursor-pointer transition"
              style={{
                background: activeSession?.id === s.id ? 'var(--bg-active)' : 'transparent',
                color: activeSession?.id === s.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.title}</div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  {s.mode === 'feynman' ? '费曼考官' : '深度答疑'}
                </div>
              </div>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  await api.deleteTutorSession(s.id);
                  setSessions((p) => p.filter((x) => x.id !== s.id));
                  if (activeSession?.id === s.id) {
                    setActiveSession(null);
                    setMessages([]);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 p-1 text-[var(--text-muted)] hover:text-[var(--danger-fg)]"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Chat Area */}
      <div className="lg:col-span-9 flex flex-col rounded-2xl zw-card overflow-hidden">
        <div
          className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-2"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div
            className="flex p-1 rounded-xl"
            style={{ background: 'var(--bg-subtle)' }}
          >
            <button
              onClick={() => setMode('feynman')}
              className="px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1"
              style={{
                background: mode === 'feynman' ? 'var(--bg-card-solid)' : 'transparent',
                color: mode === 'feynman' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <GraduationCap className="w-3.5 h-3.5" />
              费曼考官
            </button>
            <button
              onClick={() => setMode('qa')}
              className="px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1"
              style={{
                background: mode === 'qa' ? 'var(--bg-card-solid)' : 'transparent',
                color: mode === 'qa' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <MessageSquareText className="w-3.5 h-3.5" />
              深度答疑
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowContextPicker(!showContextPicker)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-secondary text-xs cursor-pointer"
            >
              <BookOpen className="w-3.5 h-3.5" />
              参考笔记 ({selectedNoteIds.length || '自动'})
            </button>
            <button onClick={() => startNewSession()} className="lg:hidden p-2 rounded-xl zw-btn-secondary" title="新对话">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {showContextPicker && (
          <div
            className="px-4 py-3 border-b max-h-36 overflow-y-auto"
            style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
          >
            <div className="text-[11px] text-[var(--text-muted)] mb-2">勾选参考笔记（不选则默认参考最近笔记）：</div>
            <div className="flex flex-wrap gap-1.5">
              {notes.map((n) => {
                const active = selectedNoteIds.includes(n.id);
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

        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-2.5 py-8">
              <Sparkles className="w-7 h-7 text-[var(--text-muted)]" />
              <h3 className="font-semibold text-sm">
                {mode === 'feynman' ? '费曼学习法：用输出倒逼深度理解' : '专属笔记助教：随时追问不留死角'}
              </h3>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                对话中的精炼结论可直接一键「存为闪卡」或「追加到笔记」，真正沉淀进你的知识库。
              </p>
            </div>
          ) : (
            messages.map((m, idx) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[88%] sm:max-w-[78%] space-y-1.5">
                  <div
                    className={`rounded-2xl px-4 py-3 text-sm ${
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
                      <MarkdownView content={m.content} className="text-sm" />
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
                        <FilePlus2 className="w-3 h-3" /> {selectedNoteIds.length ? '追加到笔记' : '存为新笔记'}
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
                className="max-w-[88%] sm:max-w-[78%] rounded-2xl rounded-bl-md px-4 py-3 border text-sm"
                style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
              >
                {streamingText ? (
                  <MarkdownView content={streamingText} className="text-sm" />
                ) : (
                  <span className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    思考中...
                  </span>
                )}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div
          className="p-3 sm:p-4 border-t space-y-2.5"
          style={{ borderColor: 'var(--border-hairline)', background: 'var(--bg-subtle)' }}
        >
          {messages.length <= 1 && (
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
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={2}
              placeholder={
                mode === 'feynman'
                  ? '用自己的话解释概念，或让考官向你提问... (Enter 发送)'
                  : '输入想请教的问题... (Enter 发送)'
              }
              className="flex-1 px-3.5 py-2.5 rounded-xl zw-input text-sm resize-none"
            />
            <button
              onClick={() => handleSend()}
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
