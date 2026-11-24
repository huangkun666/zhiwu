import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookMarked,
  CheckSquare,
  Edit3,
  Eye,
  FileCheck2,
  FolderPlus,
  Image,
  Layers,
  Loader2,
  MessageSquareText,
  Pin,
  Plus,
  Save,
  Search,
  Sparkles,
  Square,
  Tag,
  Trash2,
  Undo2,
} from 'lucide-react';
import { splitLegacyChatExcerpts, stripInlineImages } from '../../../server/src/shared/noteContent';
import { sourceBlocks, unreadPdfPage, type SourceBlock } from '../../../server/src/shared/tutorSources';
import { api } from '../api/client';
import { MarkdownView } from '../components/MarkdownView';
import { NoteSource } from '../components/NoteSource';
import { TrashList } from '../components/TrashList';
import type { Note, PageId, Synthesis, TrashedNote } from '../types';

interface NotesPageProps {
  categoryLabels: ReadonlyMap<string, string>;
  initialNoteId?: string | null;
  citation?: URLSearchParams;
  onReturnToTutor?: () => void;
  onRefreshGlobal: () => void;
  onOpenImport: () => void;
  onNavigate: (page: PageId, context?: any) => void;
}

const CAT_COLORS = ['#6366F1', '#0F766E', '#D97706', '#E11D48', '#8B5CF6', '#0284C7'];

export function NotesPage({
  categoryLabels,
  initialNoteId,
  citation,
  onReturnToTutor,
  onRefreshGlobal,
  onOpenImport,
  onNavigate,
}: NotesPageProps) {
  const [subTab, setSubTab] = useState<'notes' | 'syntheses' | 'trash'>('notes');
  const [notes, setNotes] = useState<Note[]>([]);
  const [syntheses, setSyntheses] = useState<Synthesis[]>([]);
  const [trash, setTrash] = useState<TrashedNote[]>([]);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);

  const [search, setSearch] = useState('');
  const [selectedCat, setSelectedCat] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string>('');

  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [linkedNoteError, setLinkedNoteError] = useState(false);
  const [activeSynthesis, setActiveSynthesis] = useState<Synthesis | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');
  const [editTagsText, setEditTagsText] = useState('');

  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatName, setNewCatName] = useState('');

  const [loadingList, setLoadingList] = useState(false);
  const [loadingTrash, setLoadingTrash] = useState(false);
  const [trashError, setTrashError] = useState('');
  const [changingTrash, setChangingTrash] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [toast, setToast] = useState<{ message: string; restoreId?: string } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const noteRequest = useRef(0);
  const synthesisRequest = useRef(0);
  const trashRequest = useRef(0);

  const showToast = (message: string, restoreId?: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, restoreId });
    toastTimer.current = window.setTimeout(() => setToast(null), restoreId ? 8000 : 3200);
  };

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const fetchNotes = async () => {
    const request = ++noteRequest.current;
    setLoadingList(true);
    try {
      const [list, tagList] = await Promise.all([
        api.getNotes({
          q: search.trim() || undefined,
          categoryId: selectedCat || undefined,
          tag: selectedTag || undefined,
        }),
        api.getTags(),
      ]);
      if (request === noteRequest.current) {
        setNotes(list);
        setTags(tagList);
      }
    } catch {
      // ignore
    } finally {
      if (request === noteRequest.current) setLoadingList(false);
    }
  };

  const fetchSyntheses = async () => {
    const request = ++synthesisRequest.current;
    try {
      const reports = await api.getSyntheses();
      if (request === synthesisRequest.current) setSyntheses(reports);
    } catch {
      // ignore
    }
  };

  const fetchTrash = async () => {
    const request = ++trashRequest.current;
    setLoadingTrash(true);
    setTrashError('');
    try {
      const items = await api.getTrashedNotes();
      if (request === trashRequest.current) setTrash(items);
    } catch (error) {
      if (request === trashRequest.current) setTrashError(error instanceof Error ? error.message : '无法读取回收站');
    } finally {
      if (request === trashRequest.current) setLoadingTrash(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(fetchNotes, 150);
    return () => clearTimeout(t);
  }, [search, selectedCat, selectedTag]);

  useEffect(() => {
    fetchSyntheses();
    fetchTrash();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLinkedNoteError(false);
    if (initialNoteId) {
      api
        .getNote(initialNoteId)
        .then((n) => {
          if (cancelled) return;
          setSubTab('notes');
          selectNote(n);
        })
        .catch(() => { if (!cancelled) setLinkedNoteError(true); });
    }
    return () => { cancelled = true; };
  }, [initialNoteId]);

  const selectNote = (note: Note) => {
    setLinkedNoteError(false);
    setActiveNote(note);
    setEditing(false);
  };

  const startEditing = (note: Note) => {
    setEditTitle(note.title);
    setEditContent(note.content);
    setEditCategoryId(note.category_id || '');
    setEditTagsText(note.tags.join(' '));
    setEditing(true);
  };

  const handleSaveEdit = async () => {
    if (!activeNote) return;
    const tagArr = editTagsText
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const updated = await api.updateNote(activeNote.id, {
        title: editTitle,
        content: editContent === activeNote.content ? undefined : editContent,
        categoryId: editCategoryId || null,
        tags: tagArr,
      });
      setActiveNote(updated);
      setEditing(false);
      fetchNotes();
      onRefreshGlobal();
      showToast('笔记已保存');
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleUndoChat = async (excerpt: { id: string } | { offset: number; block: string }) => {
    if (!activeNote || undoing) return;
    const noteId = activeNote.id;
    if ('offset' in excerpt && !confirm('撤销这段旧版聊天追加？')) return;

    setUndoing(true);
    try {
      const updated = 'id' in excerpt
        ? await api.removeNoteChat(noteId, excerpt.id)
        : await api.removeLegacyNoteChat(noteId, excerpt.offset, excerpt.block, activeNote.updated_at);
      setActiveNote((current) => current?.id === noteId ? updated : current);
      fetchNotes();
      onRefreshGlobal();
      showToast('已撤销聊天追加');
    } catch (error) {
      alert(error instanceof Error ? error.message : '无法撤销聊天追加');
    } finally {
      setUndoing(false);
    }
  };

  const handleTogglePin = async () => {
    if (!activeNote) return;
    const updated = await api.updateNote(activeNote.id, { isPinned: !activeNote.is_pinned });
    setActiveNote(updated);
    fetchNotes();
  };

  const handleDeleteNote = async () => {
    if (!activeNote || changingTrash) return;
    const deletedId = activeNote.id;
    setChangingTrash(true);
    try {
      await api.deleteNote(deletedId);
      if (deletedId === initialNoteId) setLinkedNoteError(true);
      setActiveNote((current) => current?.id === deletedId ? null : current);
      setCheckedIds((current) => current.filter((id) => id !== deletedId));
      setNotes((current) => current.filter((note) => note.id !== deletedId));
      setSyntheses((current) => current.map((report) => ({
        ...report,
        note_ids: report.note_ids.filter((id) => id !== deletedId),
      })));
      fetchNotes();
      fetchSyntheses();
      fetchTrash();
      onRefreshGlobal();
      showToast('已移入回收站', deletedId);
    } catch (error) {
      alert(error instanceof Error ? error.message : '无法移入回收站');
    } finally {
      setChangingTrash(false);
    }
  };

  const handleRestoreNote = async (id: string) => {
    if (changingTrash) return;
    setChangingTrash(true);
    try {
      await api.restoreNote(id);
      setTrash((items) => items.filter((note) => note.id !== id));
      fetchTrash();
      fetchNotes();
      fetchSyntheses();
      onRefreshGlobal();
      showToast('笔记已恢复');
    } catch (error) {
      alert(error instanceof Error ? error.message : '恢复笔记失败');
    } finally {
      setChangingTrash(false);
    }
  };

  const handlePurgeNote = async (note: TrashedNote) => {
    if (changingTrash || !confirm(`永久删除《${note.title}》及其原文件？此操作无法撤销。`)) return;
    setChangingTrash(true);
    try {
      await api.permanentlyDeleteNote(note.id);
      setTrash((items) => items.filter((item) => item.id !== note.id));
      fetchTrash();
      onRefreshGlobal();
      showToast('笔记已永久删除');
    } catch (error) {
      alert(error instanceof Error ? error.message : '永久删除笔记失败');
    } finally {
      setChangingTrash(false);
    }
  };

  const handleSummarize = async () => {
    if (!activeNote) return;
    setAiBusy('正在提炼摘要、要点与知识图谱...');
    try {
      const updated = await api.summarizeNote(activeNote.id, true);
      selectNote(updated);
      fetchNotes();
      onRefreshGlobal();
      showToast('AI 总结完成，已同步至图谱');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAiBusy(null);
    }
  };

  const handleGenerateFlashcards = async () => {
    if (!activeNote) return;
    setAiBusy('正在提炼记忆闪卡...');
    try {
      const res = await api.generateFlashcards(activeNote.id, 6);
      onRefreshGlobal();
      showToast(`已生成 ${res.count} 张闪卡，加入今日复习`);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAiBusy(null);
    }
  };

  const handleRerunOcr = async () => {
    if (!activeNote) return;
    setAiBusy('正在重新识别图片文字...');
    try {
      const updated = await api.rerunOcr(activeNote.id);
      selectNote(updated);
      fetchNotes();
      showToast('图片识别完成');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAiBusy(null);
    }
  };

  const handleSynthesize = async () => {
    const ids = checkedIds.length > 0 ? checkedIds : activeNote ? [activeNote.id] : [];
    if (ids.length === 0) return alert('请先勾选需要归纳的笔记');
    setAiBusy(`正在归纳整合 ${ids.length} 篇笔记...`);
    try {
      const syn = await api.synthesizeNotes({ noteIds: ids });
      setSyntheses((prev) => [syn, ...prev]);
      setActiveSynthesis(syn);
      setSubTab('syntheses');
      setMultiSelectMode(false);
      setCheckedIds([]);
      showToast('专题归纳报告已生成');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAiBusy(null);
    }
  };

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    await api.createCategory({ name: newCatName.trim(), color: CAT_COLORS[categoryLabels.size % CAT_COLORS.length] });
    setNewCatName('');
    setShowNewCat(false);
    onRefreshGlobal();
  };

  const toggleCheck = (id: string) =>
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const getCategoryLabel = (note: Note) =>
    (note.category_id && categoryLabels.get(note.category_id)) || note.category_name;

  const showDetailMobile = Boolean((subTab === 'notes' && activeNote) || (subTab === 'syntheses' && activeSynthesis));
  const legacy = useMemo(() => splitLegacyChatExcerpts(activeNote?.content ?? ''), [activeNote?.content]);
  const legacyImport = Boolean(activeNote?.source_filename && activeNote.source_type !== 'image' && activeNote.source_content == null);
  const body = useMemo(() => legacyImport ? '' : stripInlineImages(legacy.body), [legacyImport, legacy.body]);
  const source = activeNote?.source_content ?? (legacyImport ? legacy.body : null);
  const block = useMemo(() => {
    if (!citation || !activeNote || activeNote.id !== initialNoteId) return;
    if (['note', 'part', 'at', 'sig', 'page'].some((key) => citation.getAll(key).length > 1)) return;
    const candidates = sourceBlocks(activeNote);
    if (citation.has('page')) {
      const page = unreadPdfPage(activeNote, Number(citation.get('page')));
      if (page) candidates.push(page);
    }
    return candidates.find((item) => (
      item.field === citation.get('part') && String(item.index) === citation.get('at') && item.sig === citation.get('sig')
      && (!citation.has('page') || (item.page !== undefined && String(item.page) === citation.get('page')))
    ));
  }, [activeNote, initialNoteId, citation]);
  const citationError = linkedNoteError ? '无法打开这篇笔记，笔记可能已移入回收站。'
    : citation && activeNote?.id === initialNoteId && !block ? '引用段落已变更或定位信息无效。' : '';

  return (
    <div className="space-y-5">
      {(onReturnToTutor || citationError || block?.tableHeader) && (
        <div className="sticky top-[calc(env(safe-area-inset-top)+3.5rem)] md:top-2 z-20 flex w-fit max-w-full items-center gap-2 rounded-xl zw-glass border px-2 py-1 shadow-sm">
          {onReturnToTutor && <button type="button" onClick={onReturnToTutor}
            className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium hover:bg-[var(--bg-hover)]">
            <ArrowLeft className="size-4" /> 返回对话
          </button>}
          {citationError && <p role="status" className="px-1 py-1 text-sm">{citationError}</p>}
          {block?.tableHeader && <span className="min-w-0 truncate text-xs" title={block.tableHeader}>表头　{block.tableHeader}</span>}
        </div>
      )}
      {toast && (
        <div role="status" className="fixed top-[max(1rem,env(safe-area-inset-top))] right-4 z-50 flex items-center gap-3 rounded-xl zw-card border-[var(--border-strong)] px-3 py-2 text-xs font-medium shadow-lg">
          {toast.message}
          {toast.restoreId && (
            <button type="button" disabled={changingTrash} onClick={() => handleRestoreNote(toast.restoreId!)}
              className="min-h-8 rounded-lg zw-btn-secondary px-2.5 disabled:opacity-50">
              撤销
            </button>
          )}
        </div>
      )}

      {/* Top Controls */}
      <div className={`${subTab === 'notes' && activeNote ? 'hidden lg:flex' : 'flex'} flex-wrap items-center justify-between gap-3`}>
        <div
          className="inline-flex p-1 rounded-xl border"
          style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
        >
          <button
            aria-pressed={subTab === 'notes'}
            onClick={() => {
              setSubTab('notes');
              setActiveSynthesis(null);
            }}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer"
            style={{
              background: subTab === 'notes' ? 'var(--bg-card-solid)' : 'transparent',
              color: subTab === 'notes' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            笔记 ({notes.length})
          </button>
          <button
            aria-pressed={subTab === 'syntheses'}
            onClick={() => {
              setSubTab('syntheses');
              setActiveNote(null);
            }}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5"
            style={{
              background: subTab === 'syntheses' ? 'var(--bg-card-solid)' : 'transparent',
              color: subTab === 'syntheses' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            <Layers className="w-3.5 h-3.5" />
            专题归纳 ({syntheses.length})
          </button>
          <button
            type="button"
            aria-pressed={subTab === 'trash'}
            onClick={() => {
              setSubTab('trash');
              setActiveNote(null);
              setActiveSynthesis(null);
              setMultiSelectMode(false);
              setCheckedIds([]);
              fetchTrash();
            }}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1.5"
            style={{
              background: subTab === 'trash' ? 'var(--bg-card-solid)' : 'transparent',
              color: subTab === 'trash' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            <Trash2 className="size-3.5" /> 回收站{trash.length > 0 && ` (${trash.length})`}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {subTab === 'notes' && (
            <button
              onClick={() => {
                setMultiSelectMode(!multiSelectMode);
                setCheckedIds([]);
              }}
              className="px-3 py-2 rounded-xl text-xs font-medium zw-btn-secondary cursor-pointer"
              style={multiSelectMode ? { borderColor: 'var(--border-strong)', background: 'var(--bg-active)' } : undefined}
            >
              {multiSelectMode ? '退出多选' : '多选归纳'}
            </button>
          )}
          {subTab !== 'trash' && <button
            onClick={onOpenImport}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            导入 / 新建
          </button>}
        </div>
      </div>

      {/* Multi-select Bar */}
      {multiSelectMode && subTab === 'notes' && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 rounded-2xl zw-card">
          <span className="text-xs text-[var(--text-secondary)]">
            已选 <strong className="text-[var(--text-primary)]">{checkedIds.length}</strong> 篇笔记
          </span>
          <div className="flex gap-2">
            <button
              onClick={handleSynthesize}
              disabled={checkedIds.length === 0 || Boolean(aiBusy)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg zw-btn-primary text-xs font-semibold disabled:opacity-45 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              跨笔记归纳
            </button>
            <button
              onClick={() => onNavigate('practice', { subTab: 'quiz', noteIds: checkedIds })}
              disabled={checkedIds.length === 0}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg zw-btn-secondary text-xs font-medium disabled:opacity-45 cursor-pointer"
            >
              <FileCheck2 className="w-3.5 h-3.5" />
              联合出题
            </button>
          </div>
        </div>
      )}

      {/* Split Workspace */}
      {subTab === 'trash' ? (
        <TrashList notes={trash} loading={loadingTrash} error={trashError} pending={changingTrash}
          onReload={fetchTrash} onRestore={handleRestoreNote} onDelete={handlePurgeNote} />
      ) : <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left List */}
        <div className={`lg:col-span-4 space-y-3 ${showDetailMobile ? 'hidden lg:block' : 'block'}`}>
          {subTab === 'notes' ? (
            <>
              <div className="p-3.5 rounded-2xl zw-card space-y-3">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="检索标题、正文或标签..."
                    className="w-full pl-9 pr-3 py-2 rounded-xl zw-input text-xs"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] text-[var(--text-muted)]">分类</span>
                    <button
                      onClick={() => setShowNewCat(!showNewCat)}
                      className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-0.5 cursor-pointer"
                    >
                      <FolderPlus className="w-3 h-3" /> 新建
                    </button>
                  </div>

                  {showNewCat && (
                    <div className="flex gap-1.5 mb-2">
                      <input
                        value={newCatName}
                        onChange={(e) => setNewCatName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleCreateCategory()}
                        placeholder="分类名称"
                        className="flex-1 px-2.5 py-1.5 rounded-lg zw-input text-xs"
                      />
                      <button
                        onClick={handleCreateCategory}
                        className="px-2.5 py-1.5 rounded-lg zw-btn-primary text-xs font-medium cursor-pointer"
                      >
                        添加
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setSelectedCat('')}
                      className="px-2.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer"
                      style={{
                        background: selectedCat === '' ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                        color: selectedCat === '' ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                      }}
                    >
                      全部
                    </button>
                    {Array.from(categoryLabels, ([id, label]) => {
                      const on = selectedCat === id;
                      return (
                        <button
                          key={id}
                          onClick={() => setSelectedCat(on ? '' : id)}
                          className="max-w-full break-words px-2.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer"
                          style={{
                            background: on ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                            color: on ? 'var(--btn-primary-fg)' : 'var(--text-secondary)',
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {tags.length > 0 && (
                  <div
                    className="flex flex-wrap gap-1.5 pt-2 border-t"
                    style={{ borderColor: 'var(--border-hairline)' }}
                  >
                    {tags.slice(0, 10).map((t) => {
                      const on = selectedTag === t.name;
                      return (
                        <button
                          key={t.name}
                          onClick={() => setSelectedTag(on ? '' : t.name)}
                          className="text-[11px] px-2 py-0.5 rounded-md transition cursor-pointer"
                          style={{
                            background: on ? 'var(--btn-primary-bg)' : 'var(--bg-subtle)',
                            color: on ? 'var(--btn-primary-fg)' : 'var(--text-muted)',
                          }}
                        >
                          #{t.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="space-y-2 max-h-[68vh] overflow-y-auto pr-0.5">
                {loadingList ? (
                  <div className="p-8 text-center text-xs text-[var(--text-muted)]">加载中...</div>
                ) : notes.length === 0 ? (
                  <div className="p-8 rounded-2xl zw-card text-center space-y-1.5">
                    <p className="text-xs font-medium">暂无匹配笔记</p>
                    <p className="text-[11px] text-[var(--text-muted)]">点击右上角「导入 / 新建」添加学习资料</p>
                  </div>
                ) : (
                  notes.map((n) => {
                    const isActive = activeNote?.id === n.id;
                    const isChecked = checkedIds.includes(n.id);
                    const categoryLabel = getCategoryLabel(n);
                    return (
                      <div
                        key={n.id}
                        onClick={() => (multiSelectMode ? toggleCheck(n.id) : selectNote(n))}
                        className="p-3.5 rounded-2xl zw-card transition cursor-pointer"
                        style={
                          isActive
                            ? { borderColor: 'var(--border-strong)', background: 'var(--bg-active)' }
                            : undefined
                        }
                      >
                        <div className="flex items-start gap-2.5">
                          {multiSelectMode && (
                            <div className="mt-0.5 text-[var(--text-primary)]">
                              {isChecked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {n.is_pinned && <Pin className="w-3 h-3 text-[var(--text-muted)] shrink-0" />}
                              <h4 className="font-medium text-sm truncate">{n.title}</h4>
                            </div>
                            <p className="text-xs text-[var(--text-muted)] line-clamp-2 mt-1">
                              {n.summary?.abstract ||
                                (n.content || n.chat_excerpts?.[0]?.content || n.source_content || n.source_filename || '')
                                  .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
                                  .replace(/[#*`>!]/g, '')
                                  .trim()
                                  .slice(0, 90)}
                            </p>
                            <div className="flex items-center justify-between mt-2 gap-2 text-[10px] text-[var(--text-muted)]">
                              <div className="flex min-w-0 items-center gap-1.5">
                                {categoryLabel && (
                                  <span
                                    title={categoryLabel}
                                    className="truncate px-1.5 py-0.5 rounded"
                                    style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                                  >
                                    {categoryLabel}
                                  </span>
                                )}
                                {n.summary && (
                                  <span
                                    className="shrink-0 px-1.5 py-0.5 rounded"
                                    style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)' }}
                                  >
                                    已总结
                                  </span>
                                )}
                              </div>
                              <span className="shrink-0 tabular-nums">{n.word_count} 字</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {syntheses.length === 0 ? (
                <div className="p-8 rounded-2xl zw-card text-center space-y-2">
                  <Layers className="w-7 h-7 text-[var(--text-muted)] mx-auto" />
                  <p className="text-xs font-medium">暂无专题归纳报告</p>
                  <p className="text-[11px] text-[var(--text-muted)]">在笔记库点击「多选归纳」即可自动整合</p>
                </div>
              ) : (
                syntheses.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => setActiveSynthesis(s)}
                    className="p-3.5 rounded-2xl zw-card cursor-pointer transition"
                    style={
                      activeSynthesis?.id === s.id
                        ? { borderColor: 'var(--border-strong)', background: 'var(--bg-active)' }
                        : undefined
                    }
                  >
                    <h4 className="font-medium text-sm">{s.title}</h4>
                    <p className="text-[11px] text-[var(--text-muted)] mt-1">
                      {s.note_ids.length ? `${s.note_ids.length} 篇来源笔记` : '暂无可打开的来源'} · {new Date(s.created_at).toLocaleDateString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Right Detail */}
        <div className={`lg:col-span-8 ${showDetailMobile ? 'block' : 'hidden lg:block'}`}>
          {aiBusy && (
            <div className="mb-3 flex items-center gap-2.5 px-4 py-3 rounded-2xl zw-btn-primary text-xs font-medium">
              <Loader2 className="w-4 h-4 animate-spin" />
              {aiBusy}
            </div>
          )}

          {subTab === 'syntheses' ? (
            activeSynthesis ? (
              <div className="rounded-2xl zw-card p-5 sm:p-6 space-y-4">
                <div
                  className="flex items-center justify-between gap-2 pb-3 border-b"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setActiveSynthesis(null)}
                      aria-label="返回专题列表"
                      className="lg:hidden p-1.5 rounded-lg zw-btn-secondary"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>
                    <div>
                      <h2 className="text-base font-semibold">{activeSynthesis.title}</h2>
                      <p className="text-[11px] text-[var(--text-muted)]">
                        {new Date(activeSynthesis.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      if (!confirm('确定删除该专题归纳报告？')) return;
                      await api.deleteSynthesis(activeSynthesis.id);
                      setSyntheses((p) => p.filter((x) => x.id !== activeSynthesis.id));
                      setActiveSynthesis(null);
                    }}
                    className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger-fg)] cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <MarkdownView content={activeSynthesis.content} />
              </div>
            ) : (
              <div className="rounded-2xl zw-card p-12 text-center text-xs text-[var(--text-muted)]">
                选择左侧专题归纳报告查看详情
              </div>
            )
          ) : activeNote ? (
            <div className="rounded-2xl zw-card overflow-hidden">
              {/* Header */}
              <div
                className="px-5 sm:px-6 py-4 border-b space-y-3"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <button
                      onClick={() => setActiveNote(null)}
                      aria-label="返回笔记列表"
                      className="lg:hidden p-1.5 mt-0.5 rounded-lg zw-btn-secondary shrink-0"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>
                    {editing ? (
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full text-base font-semibold px-3 py-1 rounded-lg zw-input"
                      />
                    ) : (
                      <h2 className="min-w-0 break-words text-lg font-semibold leading-snug">{activeNote.title}</h2>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={handleTogglePin}
                      title={activeNote.is_pinned ? '取消置顶' : '置顶'}
                      className="p-2 rounded-lg hover:bg-[var(--bg-hover)] cursor-pointer"
                      style={{ color: activeNote.is_pinned ? 'var(--text-primary)' : 'var(--text-muted)' }}
                    >
                      <Pin className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => editing ? setEditing(false) : startEditing(activeNote)}
                      title={editing ? '预览' : '编辑'}
                      disabled={undoing}
                      className="p-2 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                    >
                      {editing ? <Eye className="w-4 h-4" /> : <Edit3 className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={handleDeleteNote}
                      title="移入回收站"
                      aria-label="移入回收站"
                      disabled={changingTrash}
                      className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger-fg)] cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  <span className="max-w-full break-words px-2 py-0.5 rounded-md" style={{ background: 'var(--bg-subtle)' }}>
                    {getCategoryLabel(activeNote) || '未分类'}
                  </span>
                  <span>·</span>
                  <span className="tabular-nums">{activeNote.word_count} 字</span>
                  {activeNote.tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md"
                      style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                    >
                      <Tag className="w-2.5 h-2.5" />
                      {t}
                    </span>
                  ))}
                </div>

                {/* Action Toolbar */}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={handleSummarize}
                    disabled={Boolean(aiBusy)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-primary text-xs font-semibold disabled:opacity-50 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {activeNote.summary ? '重新 AI 总结' : 'AI 总结'}
                  </button>
                  <button
                    onClick={() => onNavigate('practice', { subTab: 'quiz', noteIds: [activeNote.id] })}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
                  >
                    <FileCheck2 className="w-3.5 h-3.5" />
                    动态出题
                  </button>
                  <button
                    onClick={handleGenerateFlashcards}
                    disabled={Boolean(aiBusy)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
                  >
                    <BookMarked className="w-3.5 h-3.5" />
                    生成闪卡
                  </button>
                  <button
                    onClick={() =>
                      onNavigate('tutor', {
                        mode: 'feynman',
                        noteIds: [activeNote.id],
                        title: `费曼演练：${activeNote.title}`,
                      })
                    }
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                    费曼追问
                  </button>
                  {activeNote.source_type === 'image' && activeNote.attachment_path && (
                    <button
                      onClick={handleRerunOcr}
                      disabled={Boolean(aiBusy)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
                    >
                      <Image className="w-3.5 h-3.5" />
                      重新识图
                    </button>
                  )}
                </div>
              </div>

              {/* AI Summary Panel */}
              {activeNote.summary && !editing && (
                <div
                  className="mx-5 sm:mx-6 mt-5 p-4 sm:p-5 rounded-2xl border space-y-3.5"
                  style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <Sparkles className="w-3.5 h-3.5" />
                      AI 结构化提炼
                    </div>
                    {activeNote.summary.difficulty && (
                      <span
                        className="text-[11px] px-2 py-0.5 rounded-md border"
                        style={{ borderColor: 'var(--border-hairline)', color: 'var(--text-secondary)' }}
                      >
                        {activeNote.summary.difficulty}
                      </span>
                    )}
                  </div>
                  <p className="text-xs sm:text-sm text-[var(--text-secondary)] leading-relaxed">
                    {activeNote.summary.abstract}
                  </p>

                  {activeNote.summary.keyPoints?.length > 0 && (
                    <ul className="space-y-1 text-xs text-[var(--text-secondary)]">
                      {activeNote.summary.keyPoints.map((kp, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-[var(--text-muted)]">·</span>
                          <span>{kp}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {activeNote.summary.concepts?.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      {activeNote.summary.concepts.map((c, i) => (
                        <div
                          key={i}
                          className="p-2.5 rounded-xl border"
                          style={{ background: 'var(--bg-card-solid)', borderColor: 'var(--border-hairline)' }}
                        >
                          <div className="text-xs font-semibold">{c.name}</div>
                          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{c.definition}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Original Image Preview (rendered natively so data: URLs never break!) */}
              {activeNote.source_type === 'image' && activeNote.attachment_path && !editing && (
                <details
                  className="mx-5 sm:mx-6 mt-5 rounded-2xl border overflow-hidden"
                  style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
                >
                  <summary className="px-4 py-3 text-xs font-medium text-[var(--text-secondary)] cursor-pointer select-none flex items-center gap-1.5">
                    <Image className="w-3.5 h-3.5" />
                    查看原始笔记图片
                  </summary>
                  <div className="px-4 pb-4">
                    <img
                      src={activeNote.attachment_path}
                      alt={activeNote.title}
                      className="max-h-96 mx-auto rounded-xl border"
                      style={{ borderColor: 'var(--border-hairline)' }}
                    />
                  </div>
                </details>
              )}

              {/* Content Body */}
              <div className="p-5 sm:p-6 space-y-5">
                {editing ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <select
                        aria-label="分类"
                        value={editCategoryId}
                        onChange={(e) => setEditCategoryId(e.target.value)}
                        title={categoryLabels.get(editCategoryId)}
                        className="w-full min-w-0 px-3 py-2 rounded-xl zw-input text-xs"
                      >
                        <option value="">未分类</option>
                        {Array.from(categoryLabels, ([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <input
                        value={editTagsText}
                        onChange={(e) => setEditTagsText(e.target.value)}
                        placeholder="标签（空格分隔）"
                        className="px-3 py-2 rounded-xl zw-input text-xs"
                      />
                    </div>
                    <textarea
                      aria-label="笔记正文"
                      placeholder="写下你的笔记…"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={18}
                      className="w-full p-3.5 rounded-xl zw-input font-mono text-sm leading-relaxed"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditing(false)}
                        className="px-4 py-2 rounded-xl zw-btn-secondary text-xs cursor-pointer"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleSaveEdit}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5" />
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {body && <MarkdownView content={body} highlight={block?.field === 'body' ? block : undefined} />}
                    {(legacy.excerpts.length > 0 || Boolean(activeNote.chat_excerpts?.length)) && (
                      <section className="space-y-3" aria-label="聊天追加">
                        <h3 className="text-sm font-semibold">聊天追加</h3>
                        {legacy.excerpts.map((excerpt) => (
                          <NoteChatExcerpt
                            key={`legacy-${excerpt.offset}`}
                            date={excerpt.date}
                            content={excerpt.content}
                            highlight={block?.excerptId === `legacy-${excerpt.offset}` ? block : undefined}
                            disabled={undoing}
                            onUndo={() => handleUndoChat(excerpt)}
                          />
                        ))}
                        {activeNote.chat_excerpts?.map((excerpt) => (
                          <NoteChatExcerpt
                            key={excerpt.id}
                            date={new Date(excerpt.created_at).toLocaleDateString()}
                            content={excerpt.content}
                            highlight={block?.excerptId === excerpt.id ? block : undefined}
                            disabled={undoing}
                            onUndo={() => handleUndoChat(excerpt)}
                          />
                        ))}
                      </section>
                    )}
                    {(source !== null || block?.page) && <NoteSource key={`${activeNote.id}:${block?.sig ?? ''}`} note={activeNote}
                      content={source ?? ''} highlight={block?.field === 'source' ? block : undefined} />}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl zw-card p-12 text-center space-y-1.5">
              <p className="text-sm font-medium">选择左侧一篇笔记阅读或提炼</p>
              <p className="text-xs text-[var(--text-muted)]">支持 Markdown / LaTeX / PDF / Word</p>
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}

function NoteChatExcerpt({ date, content, highlight, disabled, onUndo }: {
  date: string;
  content: string;
  highlight?: SourceBlock;
  disabled: boolean;
  onUndo: () => void;
}) {
  return (
    <article className="space-y-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-subtle)] p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--text-muted)]">{date}</span>
        <button
          type="button"
          onClick={onUndo}
          disabled={disabled}
          className="inline-flex min-h-9 items-center gap-1 px-2.5 py-1.5 rounded-lg zw-btn-secondary text-xs cursor-pointer disabled:opacity-50"
        >
          <Undo2 className="w-3.5 h-3.5" /> 撤销追加
        </button>
      </div>
      <MarkdownView content={content} highlight={highlight} />
    </article>
  );
}
