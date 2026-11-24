import { useCallback, useEffect, useRef, useState } from 'react';
import { phoneMcp, type PhoneMcpAccess, type PhoneMcpState } from '../api/phoneMcpBridge';

type ConnectionOptions = Pick<PhoneMcpState, 'publicUrl' | 'clientOrigin'>;
const field = 'zw-input mt-1.5 block min-h-10 w-full min-w-0 rounded-xl px-3 py-2 text-sm';
const button = 'inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl px-3 py-2 text-xs font-semibold disabled:opacity-50';
const secondary = `zw-btn-secondary ${button}`;
const hint = 'text-xs leading-relaxed text-[var(--text-secondary)]';

function nativeError(error: unknown) {
  return error instanceof Error ? error.message : '无法连接手机上的 MCP 服务。';
}

export function PhoneMcpSettings() {
  const [server, setServer] = useState<PhoneMcpState | null>(null);
  const [access, setAccess] = useState<PhoneMcpAccess>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const changing = useRef(false);
  const version = useRef(0);

  const refresh = useCallback(async () => {
    if (changing.current) return;
    const request = ++version.current;
    try {
      const next = await phoneMcp.getState();
      if (request !== version.current) return;
      setServer(next);
      setError('');
    } catch (error) {
      if (request !== version.current) return;
      setServer(null);
      setError(nativeError(error));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const listener = phoneMcp.addListener('mcpStateChanged', next => {
      if (!mounted || changing.current) return;
      version.current++;
      setServer(next);
      setError('');
    });
    void listener.catch(() => {});
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted = false;
      version.current++;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      void listener.then(handle => handle.remove()).catch(() => {});
    };
  }, [refresh]);

  async function changeService(operation: () => Promise<PhoneMcpState>) {
    if (changing.current) return;
    changing.current = true;
    const request = ++version.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await operation();
      if (request !== version.current) return;
      setServer(next);
      return next;
    } catch (error) {
      const actual = await phoneMcp.getState().catch(() => null);
      if (request !== version.current) return;
      setServer(actual);
      setError(nativeError(error));
    } finally {
      changing.current = false;
      if (request === version.current) setBusy(false);
    }
  }

  function start(nextAccess: PhoneMcpAccess, changes?: ConnectionOptions) {
    return changeService(() => phoneMcp.start({
      access: nextAccess, publicUrl: server?.publicUrl, clientOrigin: server?.clientOrigin, ...changes,
    }));
  }

  async function changeAccess(value: PhoneMcpAccess) {
    if (!server?.running) {
      setAccess(value);
      return;
    }
    const next = await start(value);
    if (next?.running && next.access === value) setNotice('权限已更新，请在 AI 客户端更换令牌。');
  }

  async function toggle() {
    if (!server) return;
    if (server.running) {
      const next = await changeService(() => phoneMcp.stop());
      if (next && !next.running) {
        setAccess('read');
        setNotice('MCP 已关闭，原令牌已失效。');
      }
    } else {
      await start(access);
    }
  }

  if (!server) return error ? <>
    <p role="alert" className="text-xs text-[var(--danger-fg)]">{error}</p>
    <button type="button" className={secondary} onClick={refresh}>重新读取状态</button>
  </> : <p role="status" className={hint}>正在读取手机 MCP 状态…</p>;

  return <>
    <p className={hint}>开启后，外部 AI 可通过 MCP 访问这部手机上的笔记。连接期间请保持知悟运行。</p>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-auto">
        <label htmlFor="phone-mcp-access">笔记权限</label>
        <select id="phone-mcp-access" className={field} disabled={busy} value={server.running ? server.access : access}
          onChange={e => void changeAccess(e.target.value as PhoneMcpAccess)}>
          <option value="read">只读（搜索和查看笔记）</option>
          <option value="edit">可编辑（新建、追加和修改笔记）</option>
        </select>
      </div>
      <button type="button" className={server.running ? secondary : `zw-btn-primary ${button}`}
        disabled={busy} aria-pressed={server.running} onClick={toggle}>{server.running ? '关闭 MCP' : '开启 MCP'}</button>
    </div>
    {server.running && <ConnectionSettings server={server} busy={busy} refresh={refresh}
      saveConnection={changes => start(server.access, changes)}
      onNotice={setNotice} />}
    {error && <p role="alert" className="text-xs text-[var(--danger-fg)]">{error}</p>}
    {notice && <p role="status" className={hint}>{notice}</p>}
  </>;
}

function normalizeHttpUrl(value: string, kind: 'endpoint' | 'origin'): string | null {
  const address = value.trim();
  if (!address) return '';
  try {
    const url = new URL(address);
    if (!/^https?:\/\//i.test(address) || url.port === '0' || url.username || url.password || /[?#\\]/.test(address)
      || decodeURIComponent(url.hostname).includes('*')) return null;
    if (kind === 'endpoint') return url.href;
    return /^https?:\/\/[^/]+\/?$/i.test(address) ? url.origin : null;
  } catch { return null; }
}

function copyFromDocument(value: string) {
  let written = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/plain', value);
    event.preventDefault();
    written = true;
  };
  document.addEventListener('copy', onCopy);
  try { return document.execCommand('copy') && written; }
  catch { return false; }
  finally { document.removeEventListener('copy', onCopy); }
}

interface ConnectionProps {
  server: PhoneMcpState;
  busy: boolean;
  refresh: () => Promise<void>;
  saveConnection: (changes: ConnectionOptions) => Promise<PhoneMcpState | undefined>;
  onNotice: (message: string) => void;
}

function ConnectionSettings({ server, busy, refresh, saveConnection, onNotice }: ConnectionProps) {
  const [choice, setChoice] = useState('');
  const [draft, setDraft] = useState<ConnectionOptions>({});
  const draftUrl = draft.publicUrl ?? server.publicUrl ?? '';
  const draftOrigin = draft.clientOrigin ?? server.clientOrigin ?? '';
  const publicUrl = normalizeHttpUrl(draftUrl, 'endpoint');
  const clientOrigin = normalizeHttpUrl(draftOrigin, 'origin');
  const unchanged = publicUrl === (server.publicUrl ?? '') && clientOrigin === (server.clientOrigin ?? '');
  const addresses = [...new Set([server.localUrl, ...server.lanUrls, server.publicUrl].filter((url): url is string => !!url))];
  const url = addresses.includes(choice) ? choice : server.publicUrl || addresses[0];

  function edit(changes: ConnectionOptions) {
    setDraft(current => ({ ...current, ...changes }));
    onNotice('');
  }

  async function save() {
    if (publicUrl === null || clientOrigin === null) return;
    const next = await saveConnection({ publicUrl, clientOrigin });
    if (next?.running) {
      if (next.publicUrl !== server.publicUrl) setChoice(next.publicUrl ?? '');
      setDraft({});
      onNotice('连接设置已保存。');
    }
  }

  async function copy(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (!copyFromDocument(text)) {
        onNotice('无法写入剪贴板。可长按网址或显示令牌后手动复制。');
        return;
      }
    }
    onNotice(message);
  }

  return <fieldset disabled={busy} aria-label="MCP 连接信息" className="min-w-0 space-y-4 border-t border-[var(--border-hairline)] pt-4">
    <div className="space-y-2">
      <p className={hint}>在 AI 客户端的 MCP 设置中选择 HTTP（Streamable HTTP），填入从运行工具的位置能访问的网址。</p>
      <div>
        <label htmlFor="phone-mcp-address">连接地址</label>
        <select id="phone-mcp-address" className={field} value={url ?? ''} onChange={e => { setChoice(e.target.value); onNotice(''); }}>
          {addresses.map(address => <option key={address} value={address}>{address === server.localUrl ? '本机应用'
            : address === server.publicUrl ? '自定义地址' : `网络地址 · ${address.split('/')[2]}`}</option>)}
        </select>
      </div>
      {url === server.localUrl && <p className={hint}>本机地址供这部手机上运行工具的应用使用。其他设备可选网络地址，云端 AI 需要其服务器能访问的网址。</p>}
      {!server.lanUrls.length && <p className={hint}>当前未检测到其他网络地址。接入 Wi-Fi 或 VPN 后可刷新。
        <button type="button" className="ml-2 inline-flex min-h-9 items-center underline" onClick={refresh}>刷新地址</button>
      </p>}
      {url && <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">服务器 URL
          <input type="url" className={`${field} font-mono text-xs`} readOnly value={url} />
        </label>
        <button type="button" className={secondary} onClick={() => copy(url, '已复制服务器网址。')}>复制网址</button>
      </div>}
    </div>
    <details className="rounded-xl border border-[var(--border-hairline)] px-3 py-1 text-xs">
      <summary className="cursor-pointer py-2.5 font-semibold">自定义连接地址</summary>
      <div className="space-y-2.5 pb-2">
        <p className={hint}>可填写已转发到本机 MCP 的域名或隧道网址。通过公网连接时请使用 HTTPS。</p>
        <label className="block">完整 MCP 网址
          <input type="url" autoCapitalize="none" spellCheck={false} className={field} value={draftUrl}
            aria-invalid={publicUrl === null} onChange={e => edit({ publicUrl: e.target.value })} />
        </label>
        {publicUrl === null && <p className={hint}>请填写完整的 HTTP(S) 网址，并移除账号、查询参数和片段。</p>}
        <label className="block">网页客户端来源
          <input type="url" autoCapitalize="none" spellCheck={false} className={field} value={draftOrigin}
            aria-invalid={clientOrigin === null} aria-describedby="phone-mcp-origin-help"
            onChange={e => edit({ clientOrigin: e.target.value })} />
        </label>
        <p id="phone-mcp-origin-help" className={hint}>{clientOrigin === null
          ? '请填写一个确切的 HTTP(S) 来源，只保留协议、域名和可选端口。'
          : '网页客户端直接连接时，可填写你信任的网页来源（协议、域名和端口）。其他客户端留空。'}</p>
        <button type="button" className={secondary} onClick={save}
          disabled={publicUrl === null || clientOrigin === null || unchanged}>保存地址</button>
      </div>
    </details>
    <Credentials key={server.token} token={server.token} url={url} copy={copy} />
  </fieldset>;
}

function Credentials({ token, url, copy }: { token?: string; url?: string; copy: (value: string, message: string) => Promise<void> }) {
  const [visible, setVisible] = useState(false);
  if (!token) return <p className={hint}>当前令牌不可用。关闭后重新开启 MCP 可生成新令牌。</p>;

  function copyConfig() {
    const config = { mcpServers: { zhiwu: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } };
    return copy(JSON.stringify(config, null, 2), '已复制含令牌的 JSON 配置。');
  }

  return <div className="space-y-2">
    <label className="block">Bearer 令牌
      <input className={`${field} font-mono text-xs`} readOnly value={visible ? token : '••••••••'} />
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={secondary} aria-pressed={visible} onClick={() => setVisible(!visible)}>
        {visible ? '隐藏令牌' : '显示令牌'}</button>
      <button type="button" className={secondary} onClick={() => copy(token, '已复制 Bearer 令牌。')}>复制令牌</button>
      <button type="button" className={secondary} disabled={!url} onClick={copyConfig}>复制 JSON 配置</button>
    </div>
    <p className={hint}>令牌可填入客户端的 Bearer Token 栏，或使用请求头 <code>Authorization: Bearer &lt;令牌&gt;</code>。JSON 配置已包含令牌。更改权限或重新开启后，请更新客户端中的令牌。</p>
  </div>;
}
