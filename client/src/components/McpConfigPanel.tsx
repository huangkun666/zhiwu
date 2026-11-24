import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, Plug } from 'lucide-react';
import { getMcpAdapterPath, IS_STANDALONE_MODE } from '../api/client';

type Access = 'create' | 'read' | 'edit';
interface McpInputs { address: string; script: string; directory: string; access: Access }
const storageKey = 'zhiwu.mcp.config';

function initialInputs(): McpInputs {
  const defaults: McpInputs = { address: IS_STANDALONE_MODE ? '' : new URL('.', location.href).href.replace(/\/$/, ''),
    script: '', directory: '', access: 'create' };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return {
      address: typeof saved.address === 'string' ? saved.address : defaults.address,
      script: typeof saved.script === 'string' ? saved.script : '',
      directory: typeof saved.directory === 'string' ? saved.directory : '',
      access: saved.access === 'read' || saved.access === 'edit' ? saved.access : 'create',
    };
  } catch { return defaults; }
}

function configError(values: McpInputs) {
  try {
    const address = new URL(values.address);
    if (!/^https?:$/.test(address.protocol) || address.username || address.password || address.search || address.hash) throw Error();
  } catch { return '请填写运行知悟服务的 HTTP 或 HTTPS 地址。'; }
  const script = values.script.trim();
  if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(script) || !/(?:^|[\\/])mcp\.mjs$/i.test(script)) return '请填写外部 AI 所在电脑上 mcp.mjs 的完整路径。';
  if (values.directory.trim() && !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(values.directory.trim())) return '文件导入目录需要填写完整路径。';
  return '';
}

export function McpConfigPanel() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(initialInputs);
  const [status, setStatus] = useState('');
  const configBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open || IS_STANDALONE_MODE) return;
    let active = true;
    void getMcpAdapterPath().then(script => {
      if (active && script) setValues(current => current.script ? current : { ...current, script });
    }).catch(() => { /* The script path can also be entered by hand. */ });
    return () => { active = false; };
  }, [open]);

  function change(patch: Partial<McpInputs>) {
    const next = { ...values, ...patch };
    setValues(next);
    setStatus('');
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* The draft still works without device storage. */ }
  }
  const error = configError(values);
  const env: Record<string, string> = { ZHIWU_URL: values.address.trim() };
  if (values.access !== 'create') env.ZHIWU_ALLOW_READ = '1';
  if (values.access === 'edit') env.ZHIWU_ALLOW_EDIT = '1';
  if (values.directory.trim()) env.ZHIWU_IMPORT_DIR = values.directory.trim();
  const config = error ? '' : JSON.stringify({ mcpServers: { zhiwu: { command: 'node', args: [values.script.trim()], env } } }, null, 2);

  async function copy() {
    try {
      await navigator.clipboard.writeText(config);
      setStatus('已复制配置');
    } catch {
      configBox.current?.focus();
      configBox.current?.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* The text remains selected for a manual copy. */ }
      setStatus(copied ? '已复制配置' : '已选中配置，可直接复制');
    }
  }
  const inputClass = 'mt-1.5 w-full rounded-xl zw-input px-3 py-2 text-sm';
  return (
    <section className="rounded-2xl zw-card p-4 sm:p-5">
      <h2><button type="button" aria-expanded={open} aria-controls="mcp-setup" aria-label="MCP 配置"
        onClick={() => setOpen(!open)} className="flex min-h-10 w-full items-center gap-2 text-left text-sm font-semibold">
        <Plug className="size-4" aria-hidden="true" />MCP 配置
        <span className="text-xs font-normal text-[var(--text-secondary)]">连接外部 AI</span>
        <ChevronDown className={`ml-auto size-4 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button></h2>
      {open && <div id="mcp-setup" className="mt-3 space-y-4 text-sm">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">在运行外部 AI 的电脑上准备 Node.js 和已安装依赖的知悟项目。把下方配置粘贴到该 AI 客户端的 MCP 设置，重新加载后即可使用知悟工具。</p>
        {IS_STANDALONE_MODE && <p className="text-xs text-[var(--text-secondary)]">外部 AI 会读写下方地址对应的桌面资料库。手机本机的笔记可通过完整备份转移到桌面。</p>}
        <label className="block">桌面知悟服务地址<input className={inputClass} value={values.address}
          placeholder="http://电脑地址:3001" type="url" onChange={e => change({ address: e.target.value })} /></label>
        <label className="block">适配器脚本路径<input className={inputClass} value={values.script}
          placeholder="知悟项目内 server/mcp.mjs 的完整路径" onChange={e => change({ script: e.target.value })} /></label>
        <label className="block">笔记权限<select className={inputClass} value={values.access}
          onChange={e => change({ access: e.target.value as Access })}>
          <option value="create">新建笔记和追加摘录</option>
          <option value="read">也允许搜索和读取</option>
          <option value="edit">也允许读取和修改已有笔记</option>
        </select></label>
        <label className="block">文件导入目录（可选）<input className={inputClass} value={values.directory}
          placeholder="允许外部 AI 导入的本机文件夹" onChange={e => change({ directory: e.target.value })} /></label>
        {error ? <p className="text-xs text-[var(--text-secondary)]">{error}</p> :
          <label className="block">MCP JSON 配置<textarea ref={configBox} readOnly value={config} rows={8}
            className="mt-1.5 w-full rounded-xl zw-input p-3 font-mono text-xs" /></label>}
        <div className="flex items-center gap-3">
          <button type="button" disabled={!!error} onClick={copy} className="zw-btn-primary inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs disabled:opacity-50">
            <Copy className="size-3.5" aria-hidden="true" />复制配置</button>
          <span role="status" className="text-xs">{status}</span>
        </div>
      </div>}
    </section>
  );
}
