import { useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  FileText,
  FolderUp,
  ImageOff,
  Loader2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import type { ActiveModelCapability, Category, Note } from '../types';

interface QuickImportModalProps {
  open: boolean;
  categories: Category[];
  activeCapability: ActiveModelCapability | null;
  onClose: () => void;
  onOpenSettings: () => void;
  onImported: (notes: Note[]) => void;
}

export function QuickImportModal({
  open,
  categories,
  activeCapability,
  onClose,
  onOpenSettings,
  onImported,
}: QuickImportModalProps) {
  const [tab, setTab] = useState<'file' | 'paste'>('file');
  const [categoryId, setCategoryId] = useState<string>('');
  const [tagsText, setTagsText] = useState('');
  const [autoSummarize, setAutoSummarize] = useState(false);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const supportsVision = Boolean(activeCapability?.supportsVision);
  const modelLabel = activeCapability
    ? `${activeCapability.providerName}${activeCapability.model ? ` (${activeCapability.model})` : ''}`
    : '当前模型';

  const isImageFile = (f: File) =>
    f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);

  const parseTags = () =>
    tagsText
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const arr = Array.from(list);

    // Block images explicitly if current model does not support vision
    const imageFiles = arr.filter(isImageFile);
    if (imageFiles.length > 0 && !supportsVision) {
      setError(
        `当前模型「${modelLabel}」不支持视觉输入，无法上传图片笔记。请前往「设置」切换支持多模态视觉的模型（如 Gemini、GPT-4o / 4o-mini、Qwen-VL 等）并开启视觉支持。`
      );
      const nonImages = arr.filter((f) => !isImageFile(f));
      if (nonImages.length === 0) return;
    } else {
      setError('');
    }

    const valid = arr.filter((f) => {
      if (isImageFile(f)) return supportsVision;
      const ext = f.name.toLowerCase();
      return (
        ext.endsWith('.md') ||
        ext.endsWith('.markdown') ||
        ext.endsWith('.txt') ||
        ext.endsWith('.pdf') ||
        ext.endsWith('.docx')
      );
    });

    if (valid.length === 0 && imageFiles.length === 0) {
      setError(
        supportsVision
          ? '仅支持 Markdown (.md)、文本 (.txt)、PDF、Word (.docx) 及常见图片格式'
          : '仅支持 Markdown (.md)、文本 (.txt)、PDF、Word (.docx) 格式（当前模型不支持图片上传）'
      );
      return;
    }

    if (valid.length > 0) {
      setSelectedFiles((prev) => [...prev, ...valid].slice(0, 30));
    }
  };

  const handleSubmit = async () => {
    setError('');
    setWarnings([]);
    setLoading(true);
    try {
      let createdNotes: Note[] = [];
      const tags = parseTags();

      if (tab === 'paste') {
        if (!content.trim()) {
          setError('请输入或粘贴笔记内容');
          setLoading(false);
          return;
        }
        setStatusText('正在保存笔记...');
        const autoTitle =
          title.trim() ||
          content
            .split('\n')[0]
            .replace(/^#+\s*/, '')
            .trim()
            .slice(0, 40) ||
          '随手记';
        const note = await api.createNote({
          title: autoTitle,
          content,
          categoryId: categoryId || null,
          tags,
          sourceType: 'markdown',
        });
        createdNotes = [note];
      } else {
        if (selectedFiles.length === 0) {
          setError('请先选择需要导入的笔记文件');
          setLoading(false);
          return;
        }
        setStatusText(`正在解析导入 ${selectedFiles.length} 个文件...`);
        const res = await api.importFiles(selectedFiles, categoryId || null, tags);
        createdNotes = res.imported;
        if (res.warnings?.length) setWarnings(res.warnings);
      }

      if (autoSummarize && createdNotes.length > 0) {
        for (let i = 0; i < createdNotes.length; i++) {
          setStatusText(`正在 AI 总结提炼 (${i + 1}/${createdNotes.length})...`);
          try {
            const updated = await api.summarizeNote(createdNotes[i].id, true);
            createdNotes[i] = updated;
          } catch (e: any) {
            setWarnings((prev) => [...prev, `《${createdNotes[i].title}》AI总结跳过：${e.message}`]);
          }
        }
      }

      onImported(createdNotes);
      setTitle('');
      setContent('');
      setSelectedFiles([]);
      setTagsText('');
      if (warnings.length === 0) {
        onClose();
      }
    } catch (err: any) {
      setError(err?.message || '导入失败');
    } finally {
      setLoading(false);
      setStatusText('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-[2px] p-0 sm:p-4">
      <div className="w-full sm:max-w-xl bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-[#E8E5DF] max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#EFECE6]">
          <div>
            <h2 className="text-lg font-bold text-[#1C1B18]">随时导入笔记</h2>
            <p className="text-xs text-[#6F6B63]">
              支持 Markdown / PDF / Word / 快速粘贴{supportsVision ? ' / 拍照图片识别' : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-[#6F6B63] hover:bg-[#F5F3EE] hover:text-[#1C1B18]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="flex gap-2 px-5 pt-4">
          <button
            onClick={() => setTab('file')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition cursor-pointer ${
              tab === 'file'
                ? 'bg-[#3B5BDB] text-white shadow-sm'
                : 'bg-[#F5F3EE] text-[#524F49] hover:bg-[#ECE9E2]'
            }`}
          >
            <Upload className="w-4 h-4" />
            文件导入{supportsVision ? ' / 拍照' : ''}
          </button>
          <button
            onClick={() => setTab('paste')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition cursor-pointer ${
              tab === 'paste'
                ? 'bg-[#3B5BDB] text-white shadow-sm'
                : 'bg-[#F5F3EE] text-[#524F49] hover:bg-[#ECE9E2]'
            }`}
          >
            <FileText className="w-4 h-4" />
            快速粘贴 / 随手记
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4">
          {tab === 'file' ? (
            <>
              {/* Vision status notice when unsupported */}
              {!supportsVision && (
                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-relaxed">
                  <ImageOff className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
                  <div className="flex-1">
                    当前模型 <strong>{modelLabel}</strong> 不支持视觉输入，已禁用图片/拍照上传。
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenSettings();
                      }}
                      className="ml-1.5 font-semibold text-[#3B5BDB] underline cursor-pointer"
                    >
                      去设置切换支持视觉的模型 →
                    </button>
                  </div>
                </div>
              )}

              {/* Camera + Batch Folder Actions */}
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={!supportsVision}
                  onClick={() => cameraInputRef.current?.click()}
                  className={`flex items-center justify-center gap-2 py-3 px-3 rounded-xl border font-medium text-sm transition ${
                    supportsVision
                      ? 'border-[#3B5BDB]/30 bg-[#F3F5FC] text-[#3B5BDB] hover:bg-[#E8EDFA] active:scale-[0.98] cursor-pointer'
                      : 'border-[#E5E2DC] bg-[#F5F3EE] text-[#A29D94] cursor-not-allowed'
                  }`}
                >
                  {supportsVision ? <Camera className="w-4 h-4" /> : <ImageOff className="w-4 h-4" />}
                  {supportsVision ? '拍照 / 选图 OCR' : '不支持图片上传'}
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="flex items-center justify-center gap-2 py-3 px-3 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-[#3B3832] font-medium text-sm hover:bg-[#F1EFEA] active:scale-[0.98] transition cursor-pointer"
                >
                  <FolderUp className="w-4 h-4" />
                  批量导入文件夹
                </button>
              </div>

              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={supportsVision ? '.md,.markdown,.txt,.pdf,.docx,image/*' : '.md,.markdown,.txt,.pdf,.docx'}
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                // @ts-ignore webkitdirectory is supported on desktop browsers
                webkitdirectory=""
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />

              {/* Drag-and-drop area */}
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  addFiles(e.dataTransfer.files);
                }}
                className={`cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center transition ${
                  isDragging
                    ? 'border-[#3B5BDB] bg-[#F3F5FC]'
                    : 'border-[#DDD8CE] bg-[#FAF9F6] hover:border-[#3B5BDB]/60'
                }`}
              >
                <Upload className="w-8 h-8 mx-auto text-[#6F6B63] mb-2" />
                <p className="text-sm font-medium text-[#1C1B18]">点击选择文件，或将笔记拖拽到这里</p>
                <p className="text-xs text-[#8A857C] mt-1">
                  支持 .md / .txt / .pdf / .docx{supportsVision ? ' / 图片' : ''}（单次最多 30 个文件）
                </p>
              </div>

              {selectedFiles.length > 0 && (
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {selectedFiles.map((f, idx) => (
                    <div
                      key={`${f.name}-${idx}`}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-[#F5F3EE] text-xs"
                    >
                      <span className="truncate font-medium text-[#2A2824]">{f.name}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[#7A756C]">{(f.size / 1024).toFixed(0)} KB</span>
                        <button
                          onClick={() => setSelectedFiles((prev) => prev.filter((_, i) => i !== idx))}
                          className="text-[#8A857C] hover:text-red-600"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-[#524F49] mb-1">笔记标题（留空则自动从首行提取）</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="例如：操作系统进程调度算法笔记"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm focus:outline-none focus:border-[#3B5BDB] focus:bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#524F49] mb-1">正文内容（支持 Markdown 与 LaTeX 公式）</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={7}
                  placeholder="直接粘贴课堂笔记、文章片段或你的思考..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm focus:outline-none focus:border-[#3B5BDB] focus:bg-white resize-y font-mono"
                />
              </div>
            </>
          )}

          {/* Category & Tags */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-xs font-medium text-[#524F49] mb-1">归属分类（可选）</label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm focus:outline-none focus:border-[#3B5BDB]"
              >
                <option value="">暂不分类 / 交由 AI 推荐</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#524F49] mb-1">标签（空格或逗号分隔）</label>
              <input
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="如：期末复习 核心概念"
                className="w-full px-3 py-2.5 rounded-xl border border-[#E5E2DC] bg-[#FAF9F6] text-sm focus:outline-none focus:border-[#3B5BDB]"
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 p-3 rounded-xl bg-[#F3F5FC] border border-[#3B5BDB]/15 cursor-pointer">
            <input
              type="checkbox"
              checked={autoSummarize}
              onChange={(e) => setAutoSummarize(e.target.checked)}
              className="w-4 h-4 accent-[#3B5BDB] rounded"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-[#1F2E6E] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#3B5BDB]" />
                导入后自动执行 AI 总结并构建知识图谱
              </div>
              <p className="text-xs text-[#54629B]">自动提取摘要、要点、概念关联与推荐标签</p>
            </div>
          </label>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                导入提示：
              </div>
              {warnings.map((w, i) => (
                <p key={i}>• {w}</p>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-5 py-3.5 border-t border-[#EFECE6] bg-[#FAF9F6] pb-safe">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2.5 rounded-xl text-sm font-medium text-[#524F49] hover:bg-[#ECE9E2] transition cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#3B5BDB] text-white hover:bg-[#2F4AC2] disabled:opacity-60 transition shadow-sm cursor-pointer"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {statusText || '处理中...'}
              </>
            ) : (
              <>确认导入</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
