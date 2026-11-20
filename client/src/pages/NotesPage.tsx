import { useEffect, useState } from 'react';
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
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { MarkdownView } from '../components/MarkdownView';
import type { Category, Note, PageId, Synthesis } from '../types';

interface NotesPageProps {
  categories: Category[];
  initialNoteId?: string | null;
  onRefreshGlobal: () => void;
  onOpenImport: () => void;
  onNavigate: (page: PageId, context?: any) => void;
}

const CAT_COLORS = ['#3B5BDB', '#0F766E', '#B45309', '#BE123C', '#6D28D9', '#0369A1'];

export function NotesPage({
  categories,
  initialNoteId,
  onRefreshGlobal,
  onOpenImport,
  onNavigate,
}: NotesPageProps) {
  const [subTab, setSubTab] = useState<'notes' | 'syntheses'>('notes');
  const [notes, setNotes] = useState<Note[]>([]);
  const [syntheses, setSyntheses] = useState<Synthesis[]>([]);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);

  // Filters
  const [search, setSearch] = useState('');
  const [selectedCat, setSelectedCat] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string>('');

  // Selection & Detail
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [activeSynthesis, setActiveSynthesis] = useState<Synthesis | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);

  // Editor state
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');
  const [editTagsText, setEditTagsText] = useState('');

  // New Category inline
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatName, setNewCatName] = useState('');

  // Loading states
  const [loadingList, setLoadingList] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string>('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  const fetchNotes = async () => {
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
      setNotes(list);
      setTags(tagList);
    } catch {
      // ignore
    } finally {
      setLoadingList(false);
    }
  };

  const fetchSyntheses = async () => {
    try {
      const list = await api.getSyntheses();
      setSyntheses(list);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const t = setTimeout(fetchNotes, 150);
    return () => clearTimeout(t);
  }, [search, selectedCat, selectedTag]);

  useEffect(() => {
    fetchSyntheses();
  }, []);

  useEffect(() => {
    if (initialNoteId) {
      api
        .getNote(initialNoteId)
        .then((n) => {
          setSubTab('notes');
          selectNote(n);
        })
        .catch(() => {});
    }
  }, [initialNoteId]);

  const selectNote = (note: Note) => {
    setActiveNote(note);
    setEditing(false);
    setEditTitle(note.title);
    setEditContent(note.content);
    setEditCategoryId(note.category_id || '');
    setEditTagsText(note.tags.join(' '));
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
        content: editContent,
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

  const handleTogglePin = async () => {
    if (!activeNote) return;
    const updated = await api.updateNote(activeNote.id, { isPinned: !activeNote.is_pinned });
    setActiveNote(updated);
    fetchNotes();
  };

  const handleDeleteNote = async () => {
    if (!activeNote || !confirm(`确定删除笔记《${activeNote.title}》吗？`)) return;
    await api.deleteNote(activeNote.id);
    setActiveNote(null);
    fetchNotes();
    onRefreshGlobal();
    showToast('笔记已删除');
  };

  const handleSummarize = async () => {
    if (!activeNote) return;
    setAiBusy('正在深度提炼摘要、要点与知识图谱...');
    try {
      const updated = await api.summarizeNote(activeNote.id, true);
      selectNote(updated);
      fetchNotes();
      onRefreshGlobal();
      showToast('AI 总结完成，知识点已同步至图谱！');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAiBusy(null);
    }
  };

  const handleGenerateFlashcards = async () => {
    if (!activeNote) return;
    setAiBusy('正在从笔记提炼主动回忆闪卡...');
    try {
      const res = await api.generateFlashcards(activeNote.id, 6);
      onRefreshGlobal();
      showToast(`已生成 ${res.count} 张记忆闪卡，已加入今日复习队列！`);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAiBusy(null);
    }
  };

  const handleRerunOcr = async () => {
    if (!activeNote) return;
    setAiBusy('正在调用视觉模型识别图片文字...');
    try {
      const updated = await api.rerunOcr(activeNote.id);
      selectNote(updated);
      fetchNotes();
      showToast('图片识别完成！');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAiBusy(null);
    }
  };

  const handleSynthesize = async () => {
    const ids = checkedIds.length > 0 ? checkedIds : activeNote ? [activeNote.id] : [];
    if (ids.length === 0) {
      alert('请先勾选需要归纳的多篇笔记');
      return;
    }
    setAiBusy(`正在对 ${ids.length} 篇笔记进行跨笔记归纳整合...`);
    try {
      const syn = await api.synthesizeNotes({ noteIds: ids });
      setSyntheses((prev) => [syn, ...prev]);
      setActiveSynthesis(syn);
      setSubTab('syntheses');
      setMultiSelectMode(false);
      setCheckedIds([]);
      showToast('专题归纳报告已生成！');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAiBusy(null);
    }
  };

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    const color = CAT_COLORS[categories.length % CAT_COLORS.length];
    await api.createCategory({ name: newCatName.trim(), color });
    setNewCatName('');
    setShowNewCat(false);
    onRefreshGlobal();
  };

  const toggleCheck = (id: string) => {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const showDetailMobile = Boolean((subTab === 'notes' && activeNote) || (subTab === 'syntheses' && activeSynthesis));

  return (
    <div className="space-y-4">
      {toast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2.5 rounded-xl bg-[#1C1B18] text-white text-xs font-medium shadow-lg">
          {toast}
        </div>
      )}

      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setSubTab('notes');
              setActiveSynthesis(null);
            }}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition cursor-pointer ${
              subTab === 'notes' ? 'bg-[#1C1B18] text-white' : 'bg-white border border-[#E5E2DC] text-[#524F49]'
            }`}
          >
            笔记库 ({notes.length})
          </button>
          <button
            onClick={() => {
              setSubTab('syntheses');
              setActiveNote(null);
            }}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition cursor-pointer flex items-center gap-1.5 ${
              subTab === 'syntheses' ? 'bg-[#1C1B18] text-white' : 'bg-white border border-[#E5E2DC] text-[#524F49]'
            }`}
          >
            <Layers className="w-4 h-4" />
            专题归纳 ({syntheses.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          {subTab === 'notes' && (
            <button
              onClick={() => {
                setMultiSelectMode(!multiSelectMode);
                setCheckedIds([]);
              }}
              className={`px-3 py-2 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                multiSelectMode
                  ? 'bg-[#F3F5FC] border-[#3B5BDB] text-[#3B5BDB]'
                  : 'bg-white border-[#E5E2DC] text-[#524F49] hover:bg-[#F5F3EE]'
              }`}
            >
              {multiSelectMode ? '退出多选' : '多选归纳'}
            </button>
          )}
          <button
            onClick={onOpenImport}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold hover:bg-[#2F4AC2] cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            导入 / 新建
          </button>
        </div>
      </div>

      {/* Multi-select synthesis floating bar */}
      {multiSelectMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 rounded-2xl bg-[#F3F5FC] border border-[#3B5BDB]/30">
          <span className="text-xs font-medium text-[#1F2E6E]">
            已选择 <strong>{checkedIds.length}</strong> 篇笔记，可一键跨笔记总结归纳或联合出题
          </span>
          <div className="flex gap-2">
            <button
              onClick={handleSynthesize}
              disabled={checkedIds.length === 0 || Boolean(aiBusy)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#3B5BDB] text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              AI 跨笔记归纳
            </button>
            <button
              onClick={() => onNavigate('practice', { subTab: 'quiz', noteIds: checkedIds })}
              disabled={checkedIds.length === 0}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-white border border-[#3B5BDB]/30 text-[#3B5BDB] text-xs font-semibold disabled:opacity-50 cursor-pointer"
            >
              <FileCheck2 className="w-3.5 h-3.5" />
              联合出题
            </button>
          </div>
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left List Column */}
        <div className={`lg:col-span-4 space-y-3 ${showDetailMobile ? 'hidden lg:block' : 'block'}`}>
          {subTab === 'notes' ? (
            <>
              {/* Search & Category Filter Card */}
              <div className="p-3.5 rounded-2xl bg-white border border-[#EAE6DF] space-y-3">
                <div className="relative">
                  <Search className="w-4 h-4 text-[#8A857C] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="检索笔记标题、正文或标签..."
                    className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#FAF9F6] border border-[#E5E2DC] text-xs focus:outline-none focus:border-[#3B5BDB]"
                  />
                </div>

                {/* Category Chips */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-semibold text-[#7A756C]">学科分类</span>
                    <button
                      onClick={() => setShowNewCat(!showNewCat)}
                      className="text-[11px] text-[#3B5BDB] flex items-center gap-0.5 hover:underline cursor-pointer"
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
                        placeholder="分类名称..."
                        className="flex-1 px-2.5 py-1.5 rounded-lg border border-[#DDD8CE] text-xs outline-none focus:border-[#3B5BDB]"
                      />
                      <button
                        onClick={handleCreateCategory}
                        className="px-2.5 py-1.5 rounded-lg bg-[#3B5BDB] text-white text-xs font-medium"
                      >
                        添加
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setSelectedCat('')}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                        selectedCat === '' ? 'bg-[#1C1B18] text-white' : 'bg-[#F5F3EE] text-[#524F49]'
                      }`}
                    >
                      全部
                    </button>
                    {categories.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setSelectedCat(selectedCat === c.id ? '' : c.id)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 cursor-pointer ${
                          selectedCat === c.id ? 'bg-[#3B5BDB] text-white' : 'bg-[#F5F3EE] text-[#524F49]'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: selectedCat === c.id ? '#fff' : c.color }}
                        />
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Popular Tags */}
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1 border-t border-[#F2EFEA]">
                    {tags.slice(0, 10).map((t) => (
                      <button
                        key={t.name}
                        onClick={() => setSelectedTag(selectedTag === t.name ? '' : t.name)}
                        className={`text-[11px] px-2 py-0.5 rounded-full transition cursor-pointer ${
                          selectedTag === t.name
                            ? 'bg-[#0F766E] text-white'
                            : 'bg-[#FAF9F6] border border-[#E8E5DF] text-[#6F6B63]'
                        }`}
                      >
                        #{t.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Note Cards List */}
              <div className="space-y-2 max-h-[68vh] overflow-y-auto pr-0.5">
                {loadingList ? (
                  <div className="p-8 text-center text-xs text-[#8A857C]">加载中...</div>
                ) : notes.length === 0 ? (
                  <div className="p-8 rounded-2xl bg-white border border-[#EAE6DF] text-center space-y-2">
                    <p className="text-sm font-medium text-[#524F49]">暂无匹配笔记</p>
                    <p className="text-xs text-[#8A857C]">点击右上角「导入 / 新建」随时添加学习资料</p>
                  </div>
                ) : (
                  notes.map((n) => {
                    const isActive = activeNote?.id === n.id;
                    const isChecked = checkedIds.includes(n.id);
                    return (
                      <div
                        key={n.id}
                        onClick={() => (multiSelectMode ? toggleCheck(n.id) : selectNote(n))}
                        className={`p-3.5 rounded-2xl border transition cursor-pointer ${
                          isActive
                            ? 'bg-[#F3F5FC] border-[#3B5BDB]'
                            : 'bg-white border-[#EAE6DF] hover:border-[#CFCAC0]'
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          {multiSelectMode && (
                            <div className="mt-0.5 text-[#3B5BDB]">
                              {isChecked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {n.is_pinned && <Pin className="w-3 h-3 text-amber-500 shrink-0" />}
                              <h4 className="font-semibold text-sm text-[#141311] truncate">{n.title}</h4>
                            </div>
                            <p className="text-xs text-[#6F6B63] line-clamp-2 mt-1">
                              {n.summary?.abstract || n.content.replace(/[#*`>!]/g, '').slice(0, 90)}
                            </p>
                            <div className="flex items-center justify-between mt-2 gap-2">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {n.category_name && (
                                  <span className="text-[10px] px-2 py-0.5 rounded-md bg-[#F1EFEA] text-[#4A4741] font-medium">
                                    {n.category_name}
                                  </span>
                                )}
                                {n.summary && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[#E8EDFA] text-[#3B5BDB] font-medium">
                                    已总结
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] text-[#9C978E] shrink-0">
                                {n.word_count} 字
                              </span>
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
            /* Syntheses List */
            <div className="space-y-2">
              {syntheses.length === 0 ? (
                <div className="p-8 rounded-2xl bg-white border border-[#EAE6DF] text-center space-y-2">
                  <Layers className="w-8 h-8 text-[#B9B4AA] mx-auto" />
                  <p className="text-sm font-medium text-[#524F49]">还没有专题归纳报告</p>
                  <p className="text-xs text-[#8A857C]">
                    切回「笔记库」，点击「多选归纳」勾选多篇笔记即可由 AI 自动汇总横向对比表与复习指南。
                  </p>
                </div>
              ) : (
                syntheses.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => setActiveSynthesis(s)}
                    className={`p-3.5 rounded-2xl border cursor-pointer transition ${
                      activeSynthesis?.id === s.id
                        ? 'bg-[#F3F5FC] border-[#3B5BDB]'
                        : 'bg-white border-[#EAE6DF] hover:border-[#CFCAC0]'
                    }`}
                  >
                    <h4 className="font-semibold text-sm text-[#141311]">{s.title}</h4>
                    <p className="text-xs text-[#7A756C] mt-1">
                      整合 {s.note_ids.length} 篇笔记 · {new Date(s.created_at).toLocaleDateString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Right Detail / Editor Column */}
        <div className={`lg:col-span-8 ${showDetailMobile ? 'block' : 'hidden lg:block'}`}>
          {aiBusy && (
            <div className="mb-3 flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-[#3B5BDB] text-white text-sm font-medium shadow-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {aiBusy}
            </div>
          )}

          {subTab === 'syntheses' ? (
            activeSynthesis ? (
              <div className="rounded-2xl bg-white border border-[#EAE6DF] p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#EFECE6]">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setActiveSynthesis(null)}
                      className="lg:hidden p-1.5 rounded-lg bg-[#F5F3EE]"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>
                    <div>
                      <h2 className="text-lg font-bold text-[#141311]">{activeSynthesis.title}</h2>
                      <p className="text-xs text-[#8A857C]">
                        生成于 {new Date(activeSynthesis.created_at).toLocaleString()}
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
                    className="p-2 rounded-lg text-[#8A857C] hover:text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <MarkdownView content={activeSynthesis.content} />
              </div>
            ) : (
              <div className="rounded-2xl bg-white border border-[#EAE6DF] p-12 text-center text-sm text-[#8A857C]">
                请选择左侧的一份专题归纳报告查看详情
              </div>
            )
          ) : activeNote ? (
            <div className="rounded-2xl bg-white border border-[#EAE6DF] overflow-hidden">
              {/* Note Action Bar */}
              <div className="px-4 sm:px-6 py-4 border-b border-[#EFECE6] space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <button
                      onClick={() => setActiveNote(null)}
                      className="lg:hidden p-1.5 mt-0.5 rounded-lg bg-[#F5F3EE] shrink-0"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>
                    {editing ? (
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full text-lg font-bold px-2.5 py-1 rounded-lg border border-[#3B5BDB] outline-none"
                      />
                    ) : (
                      <h2 className="text-lg sm:text-xl font-bold text-[#141311] leading-snug">{activeNote.title}</h2>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={handleTogglePin}
                      title="置顶笔记"
                      className={`p-2 rounded-lg transition cursor-pointer ${
                        activeNote.is_pinned ? 'text-amber-500 bg-amber-50' : 'text-[#8A857C] hover:bg-[#F5F3EE]'
                      }`}
                    >
                      <Pin className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setEditing(!editing)}
                      title={editing ? '预览' : '编辑'}
                      className="p-2 rounded-lg text-[#524F49] hover:bg-[#F5F3EE] cursor-pointer"
                    >
                      {editing ? <Eye className="w-4 h-4" /> : <Edit3 className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={handleDeleteNote}
                      title="删除"
                      className="p-2 rounded-lg text-[#8A857C] hover:text-red-600 hover:bg-red-50 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Metadata row */}
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#6F6B63]">
                  <span className="px-2 py-0.5 rounded-md bg-[#F5F3EE] font-medium">
                    {activeNote.category_name || '未分类'}
                  </span>
                  <span className="text-[#9C978E]">·</span>
                  <span>{activeNote.word_count} 字</span>
                  <span className="text-[#9C978E]">·</span>
                  <span className="uppercase text-[11px]">{activeNote.source_type}</span>
                  {activeNote.tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-0.5 text-[#3B5BDB] bg-[#F3F5FC] px-2 py-0.5 rounded-full">
                      <Tag className="w-3 h-3" />
                      {t}
                    </span>
                  ))}
                </div>

                {/* AI Learning Actions Toolbar */}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={handleSummarize}
                    disabled={Boolean(aiBusy)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold hover:bg-[#2F4AC2] disabled:opacity-50 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {activeNote.summary ? '重新 AI 总结' : 'AI 总结与提炼'}
                  </button>
                  <button
                    onClick={() => onNavigate('practice', { subTab: 'quiz', noteIds: [activeNote.id] })}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F3F5FC] text-[#3B5BDB] text-xs font-semibold hover:bg-[#E8EDFA] cursor-pointer"
                  >
                    <FileCheck2 className="w-3.5 h-3.5" />
                    基于此笔记出题
                  </button>
                  <button
                    onClick={handleGenerateFlashcards}
                    disabled={Boolean(aiBusy)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#EEF8F6] text-[#0F766E] text-xs font-semibold hover:bg-[#DCF1ED] cursor-pointer"
                  >
                    <BookMarked className="w-3.5 h-3.5" />
                    一键制闪卡
                  </button>
                  <button
                    onClick={() =>
                      onNavigate('tutor', {
                        mode: 'feynman',
                        noteIds: [activeNote.id],
                        title: `费曼演练：${activeNote.title}`,
                      })
                    }
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-50 text-amber-800 text-xs font-semibold hover:bg-amber-100 cursor-pointer"
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                    费曼追问
                  </button>
                  {activeNote.source_type === 'image' && activeNote.attachment_path && (
                    <button
                      onClick={handleRerunOcr}
                      disabled={Boolean(aiBusy)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F5F3EE] text-[#2A2824] text-xs font-semibold hover:bg-[#ECE9E2] cursor-pointer"
                    >
                      <Image className="w-3.5 h-3.5" />
                      重新识别图片文字
                    </button>
                  )}
                </div>
              </div>

              {/* AI Structured Summary Card */}
              {activeNote.summary && !editing && (
                <div className="mx-4 sm:mx-6 mt-5 p-4 sm:p-5 rounded-2xl bg-gradient-to-br from-[#F4F6FD] to-[#FAF9F6] border border-[#3B5BDB]/15 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-sm font-bold text-[#1E2B58]">
                      <Sparkles className="w-4 h-4 text-[#3B5BDB]" />
                      AI 结构化知识提炼
                    </div>
                    {activeNote.summary.difficulty && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-white border border-[#3B5BDB]/20 text-[#3B5BDB]">
                        难度：{activeNote.summary.difficulty}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-[#2A2D3E] leading-relaxed">{activeNote.summary.abstract}</p>

                  {activeNote.summary.keyPoints?.length > 0 && (
                    <div>
                      <div className="text-xs font-bold text-[#49527A] mb-1.5">核心要点</div>
                      <ul className="space-y-1 text-xs text-[#2A2D3E]">
                        {activeNote.summary.keyPoints.map((kp, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-[#3B5BDB] font-bold">•</span>
                            <span>{kp}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {activeNote.summary.concepts?.length > 0 && (
                    <div>
                      <div className="text-xs font-bold text-[#49527A] mb-1.5">核心概念词条（已同步知识图谱）</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {activeNote.summary.concepts.map((c, i) => (
                          <div key={i} className="p-2.5 rounded-xl bg-white border border-[#E5E8F5]">
                            <div className="text-xs font-bold text-[#3B5BDB]">{c.name}</div>
                            <div className="text-[11px] text-[#52566B] mt-0.5">{c.definition}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Content Body / Editor */}
              <div className="p-4 sm:p-6">
                {editing ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <select
                        value={editCategoryId}
                        onChange={(e) => setEditCategoryId(e.target.value)}
                        className="px-3 py-2 rounded-xl border border-[#DDD8CE] text-xs"
                      >
                        <option value="">未分类</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <input
                        value={editTagsText}
                        onChange={(e) => setEditTagsText(e.target.value)}
                        placeholder="标签（空格分隔）"
                        className="px-3 py-2 rounded-xl border border-[#DDD8CE] text-xs"
                      />
                    </div>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={18}
                      className="w-full p-3.5 rounded-xl border border-[#DDD8CE] font-mono text-sm leading-relaxed focus:outline-none focus:border-[#3B5BDB]"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditing(false)}
                        className="px-4 py-2 rounded-xl text-xs font-medium text-[#524F49] bg-[#F5F3EE]"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleSaveEdit}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-[#3B5BDB] text-white"
                      >
                        <Save className="w-3.5 h-3.5" />
                        保存修改
                      </button>
                    </div>
                  </div>
                ) : (
                  <MarkdownView content={activeNote.content} />
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-white border border-[#EAE6DF] p-12 text-center space-y-2">
              <Sparkles className="w-8 h-8 text-[#C7C2B8] mx-auto" />
              <p className="text-sm font-medium text-[#524F49]">从左侧选择一篇笔记阅读、总结或出题</p>
              <p className="text-xs text-[#8A857C]">支持 Markdown / LaTeX 公式 / PDF / Word / 拍照笔记</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
