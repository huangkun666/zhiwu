import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { PhoneMcpRequest } from './phoneMcpTools';

export type PhoneMcpAccess = 'read' | 'edit';

export interface PhoneMcpState {
  running: boolean;
  access: PhoneMcpAccess;
  localUrl: string;
  lanUrls: string[];
  publicUrl?: string;
  clientOrigin?: string;
  token?: string;
}

interface PhoneMcpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface PhoneMcpPlugin {
  getState(): Promise<PhoneMcpState>;
  start(options: { access: PhoneMcpAccess; publicUrl?: string; clientOrigin?: string }): Promise<PhoneMcpState>;
  stop(): Promise<PhoneMcpState>;
  addListener(event: 'mcpRequest', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'mcpStateChanged', listener: (state: PhoneMcpState) => void): Promise<PluginListenerHandle>;
  takeRequest(options: { id: string }): Promise<{ request: PhoneMcpRequest | null }>;
  respond(options: PhoneMcpResponse & { id: string }): Promise<void>;
}

export const phoneMcp = registerPlugin<PhoneMcpPlugin>('ZhiwuMcp');
export const isAndroidPhoneMcp = () => Capacitor.getPlatform() === 'android';
export const isPhoneMcpAvailable = () => isAndroidPhoneMcp() && Capacitor.isPluginAvailable('ZhiwuMcp');

export function servePhoneMcp(onChanged: () => void) {
  if (!isPhoneMcpAvailable()) return () => {};
  let mounted = true;
  let queue = Promise.resolve();

  async function answer(id: string) {
    if (!mounted) return;
    const tools = await import('./phoneMcpTools').catch(() => null);
    if (!mounted) return;
    const { request } = await phoneMcp.takeRequest({ id });
    if (!request || !mounted) return;
    let response: PhoneMcpResponse;
    try {
      if (!tools) throw new Error('无法载入手机笔记工具');
      response = await tools.handlePhoneMcpRequest(request, onChanged);
    } catch {
      response = {
        status: 503, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '手机暂时无法完成这次请求，请检查知悟的连接状态。' } }),
      };
    }
    await phoneMcp.respond({ id, ...response });
  }

  const listener = phoneMcp.addListener('mcpRequest', ({ id }) => {
    // Claim each request only when ready to execute. The native host rechecks expiry and revocation.
    queue = queue.then(() => answer(id)).catch(() => {});
  });
  // A legacy or shutting-down WebView may lose its bridge while registering.
  void listener.catch(() => {});
  return () => {
    mounted = false;
    void listener.then(handle => handle.remove()).catch(() => {});
  };
}
