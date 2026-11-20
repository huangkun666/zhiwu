import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  GraduationCap,
  Loader2,
  MessageSquareText,
  Plus,
  Send,
  Sparkles,
  Trash2,
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
}

export function TutorPage({ initialContext }: TutorPageProps) {
  const [sessions, setSessions] = useState<TutorSession[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeSession, setActiveSession] = useState<TutorSession | null>(null);
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [mode, setMode] = useState<'qa' | 'feynman'>('feynman');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

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
    if (opts?.initialPrompt) {
      setInput(opts.initialPrompt);
    }
  };

  useEffect(() => {
    loadSessions().then(({ sessList }) => {
      if (initialContext) {
        startNewSession(initialContext);
      } else if (sessList.length > 0) {
        openSession(sessList[0].id);
      }
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSend = async (customText?: string) => {
    const text = (customText ?? input).trim();
    if (!text || sending) return;

    let session = activeSession;
    if (!session) {
      session = await api.createTutorSession({
        mode,
        noteIds: selectedNoteIds,
        title: text.slice(0, 22),
      });
      setSessions((p) => [session!, ...p]);
      setActiveSession(session);
    }

    setInput('');
    setSending(true);
    const optimisticUser: TutorMessage = {
      id: `temp-${Date.now()}`,
      session_id: session.id,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);

    try {
      const res = await api.sendTutorMessage(session.id, {
        message: text,
        noteIds: selectedNoteIds,
        mode,
      });
      setMessages((prev) => [...prev.filter((m) => m.id !== optimisticUser.id), res.userMessage, res.assistantMessage]);
    } catch (e: any) {
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

  const quickPrompts =
    mode === 'feynman'
      ? ['请给我出一道开放式追问，检验我是否真懂了这篇笔记', '我用大白话复述一下核心原理，你帮我挑刺打分', '这个知识点最容易在哪些边界条件下被误用？']
      : ['用生活中的通俗类比帮我讲透核心原理', '帮我提炼这份笔记里最容易混淆的 3 个考点', '这些知识在实际场景中怎么应用？'];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-[calc(100vh-8.5rem)] md:h-[calc(100vh-4rem)]">
      {/* Left Sessions Sidebar (Desktop) */}
      <div className="hidden lg:flex lg:col-span-3 flex-col rounded-2xl bg-white border border-[#EAE6DF] overflow-hidden">
        <div className="p-3.5 border-b border-[#EFECE6] space-y-2">
          <button
            onClick={() => startNewSession({ mode: 'feynman' })}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0D625B] cursor-pointer"
          >
            <GraduationCap className="w-4 h-4" />
            新建费曼考官演练
          </button>
          <button
            onClick={() => startNewSession({ mode: 'qa' })}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[#F3F5FC] text-[#3B5BDB] text-xs font-semibold hover:bg-[#E8EDFA] cursor-pointer"
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
              className={`group flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-xs cursor-pointer transition ${
                activeSession?.id === s.id ? 'bg-[#F3F5FC] text-[#3B5BDB] font-semibold' : 'hover:bg-[#F5F3EE] text-[#4A4741]'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{s.title}</div>
                <div className="text-[10px] text-[#8A857C]">
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
                className="opacity-0 group-hover:opacity-100 p-1 text-[#9C978E] hover:text-red-600"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Main Chat Panel */}
      <div className="lg:col-span-9 flex flex-col rounded-2xl bg-white border border-[#EAE6DF] overflow-hidden">
        {/* Chat Header */}
        <div className="px-4 py-3 border-b border-[#EFECE6] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex bg-[#F5F3EE] p-1 rounded-xl">
              <button
                onClick={() => setMode('feynman')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1 ${
                  mode === 'feynman' ? 'bg-white text-[#0F766E] shadow-sm' : 'text-[#6F6B63]'
                }`}
              >
                <GraduationCap className="w-3.5 h-3.5" />
                费曼考官
              </button>
              <button
                onClick={() => setMode('qa')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1 ${
                  mode === 'qa' ? 'bg-white text-[#3B5BDB] shadow-sm' : 'text-[#6F6B63]'
                }`}
              >
                <MessageSquareText className="w-3.5 h-3.5" />
                深度答疑
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowContextPicker(!showContextPicker)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border cursor-pointer ${
                selectedNoteIds.length > 0
                  ? 'bg-[#F3F5FC] border-[#3B5BDB]/30 text-[#3B5BDB]'
                  : 'bg-[#FAF9F6] border-[#E5E2DC] text-[#524F49]'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              参考笔记 ({selectedNoteIds.length || '自动'})
            </button>
            <button
              onClick={() => startNewSession()}
              className="lg:hidden p-2 rounded-xl bg-[#F5F3EE] text-[#1C1B18]"
              title="新对话"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Collapsible Context Note Picker */}
        {showContextPicker && (
          <div className="px-4 py-3 bg-[#FAF9F6] border-b border-[#EFECE6] max-h-40 overflow-y-auto">
            <div className="text-[11px] font-semibold text-[#6F6B63] mb-2">
              勾选你想让助教重点参考的学习笔记（不选则默认参考最近更新的笔记）：
            </div>
            <div className="flex flex-wrap gap-1.5">
              {notes.map((n) => {
                const active = selectedNoteIds.includes(n.id);
                return (
                  <button
                    key={n.id}
                    onClick={() =>
                      setSelectedNoteIds((p) => (p.includes(n.id) ? p.filter((x) => x !== n.id) : [...p, n.id]))
                    }
                    className={`px-2.5 py-1 rounded-lg text-xs border transition cursor-pointer ${
                      active ? 'bg-[#3B5BDB] border-[#3B5BDB] text-white' : 'bg-white border-[#E5E2DC] text-[#4A4741]'
                    }`}
                  >
                    {n.title}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Messages Stream */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-3 py-8">
              <div className="w-12 h-12 rounded-2xl bg-[#EEF8F6] text-[#0F766E] flex items-center justify-center">
                <Sparkles className="w-6 h-6" />
              </div>
              <h3 className="font-bold text-base text-[#141311]">
                {mode === 'feynman' ? '费曼学习法：用输出倒逼深度理解' : '专属笔记助教：随时追问不留死角'}
              </h3>
              <p className="text-xs text-[#7A756C] leading-relaxed">
                {mode === 'feynman'
                  ? '试着用你自己的语言解释一个刚刚学过的概念，AI 会像严格又温柔的考官一样发现漏洞并层层追问。'
                  : '针对你导入的任何一篇笔记提问，支持举例类比、对比辨析和公式拆解。'}
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[88%] sm:max-w-[78%] rounded-2xl px-4 py-3 text-sm ${
                    m.role === 'user'
                      ? 'bg-[#3B5BDB] text-white rounded-br-md'
                      : 'bg-[#FAF9F6] border border-[#EAE6DF] text-[#1C1B18] rounded-bl-md'
                  }`}
                >
                  {m.role === 'user' ? (
                    <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
                  ) : (
                    <MarkdownView content={m.content} className="text-sm" />
                  )}
                </div>
              </div>
            ))
          )}

          {sending && (
            <div className="flex justify-start">
              <div className="px-4 py-3 rounded-2xl bg-[#FAF9F6] border border-[#EAE6DF] text-xs text-[#6F6B63] flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-[#3B5BDB]" />
                正在结合你的笔记深度思考...
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Starter Chips & Input Box */}
        <div className="p-3 sm:p-4 border-t border-[#EFECE6] bg-[#FAF9F6] space-y-2.5">
          {messages.length <= 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {quickPrompts.map((qp, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(qp)}
                  className="shrink-0 px-3 py-1.5 rounded-full bg-white border border-[#E5E2DC] text-[11px] text-[#4A4741] hover:border-[#3B5BDB] hover:text-[#3B5BDB] cursor-pointer"
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
                  ? '用你自己的话解释一个概念，或让考官开始向你提问... (Enter 发送)'
                  : '输入你想请教的问题... (Enter 发送)'
              }
              className="flex-1 px-3.5 py-2.5 rounded-xl bg-white border border-[#DDD8CE] text-sm focus:outline-none focus:border-[#3B5BDB] resize-none"
            />
            <button
              onClick={() => handleSend()}
              disabled={sending || !input.trim()}
              className="p-3 rounded-xl bg-[#3B5BDB] text-white hover:bg-[#2F4AC2] disabled:opacity-50 cursor-pointer shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
