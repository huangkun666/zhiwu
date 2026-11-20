export interface OtaConfig {
  repo: string; // e.g. huangkun666/zhiwu
  token: string; // optional for public repo, required for private GitHub repo
}

export interface NativeOtaState {
  isNative: boolean;
  nativeVersion: number;
  otaVersion: string;
  isOtaActive: boolean;
}

export interface RemoteReleaseInfo {
  version: string;
  nativeVersion: number;
  changelog: string;
  updatedAt: string;
  bundleDownloadUrl: string;
  apkDownloadUrl: string;
  needsApkReinstall: boolean;
  hasUpdate: boolean;
}

const OTA_CFG_KEY = 'zhiwu_ota_config';
export const BUILTIN_APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0';

export function getOtaConfig(): OtaConfig {
  try {
    const raw = localStorage.getItem(OTA_CFG_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { repo: p.repo || 'huangkun666/zhiwu', token: p.token || '' };
    }
  } catch {
    // ignore
  }
  return { repo: 'huangkun666/zhiwu', token: '' };
}

export function saveOtaConfig(cfg: OtaConfig) {
  try {
    localStorage.setItem(OTA_CFG_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

export function getNativeOtaState(): NativeOtaState {
  try {
    const raw = (window as any).ZhiwuNative?.getOtaState?.();
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return { isNative: false, nativeVersion: 2, otaVersion: '', isOtaActive: false };
}

export function getCurrentDisplayVersion(): string {
  const native = getNativeOtaState();
  return native.isOtaActive && native.otaVersion ? native.otaVersion : BUILTIN_APP_VERSION;
}

export async function checkRemoteUpdate(cfg: OtaConfig): Promise<RemoteReleaseInfo> {
  const repo = cfg.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  if (!repo.includes('/')) throw new Error('仓库格式应为 用户名/仓库名（如 huangkun666/zhiwu）');

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (cfg.token.trim()) {
    headers['Authorization'] = `Bearer ${cfg.token.trim()}`;
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/latest-ota`, { headers });
  if (res.status === 404) {
    throw new Error(
      cfg.token.trim()
        ? '尚未找到 latest-ota 发布记录，请等待云端构建完成'
        : '无法读取私有仓库更新（404），如为私有仓库请在下方填入 GitHub Token（或将仓库设为公开）'
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('GitHub Token 无效或缺少 repo 权限');
  }
  if (!res.ok) {
    throw new Error(`检查更新失败 (HTTP ${res.status})`);
  }

  const rel = await res.json();
  const assets: any[] = rel.assets || [];
  const bundleAsset = assets.find((a) => a.name === 'web-bundle.zip');
  const apkAsset = assets.find((a) => a.name === 'zhiwu-android.apk');

  if (!bundleAsset) {
    throw new Error('云端发布包中缺少 web-bundle.zip，请稍后重试');
  }

  // Parse metadata cleanly from release body JSON header or fallback to release fields
  let version = rel.name?.replace(/^v/i, '') || '1.0.0';
  let nativeVersion = 2;
  let changelog = rel.body || '常规功能优化与体验升级';
  const metaMatch = String(rel.body || '').match(/<!--ZHIWU_META:(.*?)-->/);
  if (metaMatch?.[1]) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      if (meta.version) version = String(meta.version);
      if (meta.nativeVersion) nativeVersion = Number(meta.nativeVersion);
      if (meta.changelog) changelog = String(meta.changelog);
    } catch {
      // ignore
    }
  }

  const native = getNativeOtaState();
  const currentVer = getCurrentDisplayVersion();
  // Private repo asset download MUST use asset.url (API endpoint); public repo can use browser_download_url
  const bundleDownloadUrl = cfg.token.trim() ? bundleAsset.url : bundleAsset.browser_download_url;
  const apkDownloadUrl = apkAsset?.browser_download_url || rel.html_url;

  return {
    version,
    nativeVersion,
    changelog,
    updatedAt: rel.published_at || rel.created_at || '',
    bundleDownloadUrl,
    apkDownloadUrl,
    needsApkReinstall: nativeVersion > native.nativeVersion,
    hasUpdate: version !== currentVer,
  };
}

export function triggerNativeOtaUpdate(
  downloadUrl: string,
  version: string,
  token: string,
  onProgress: (ev: { status: string; message: string }) => void
) {
  const bridge = (window as any).ZhiwuNative;
  if (!bridge?.applyOtaUpdate) {
    throw new Error('仅安卓 App 内支持一键热更新');
  }
  (window as any).__zhiwuOtaEvent = (ev: { status: string; message: string }) => {
    onProgress(ev);
  };
  bridge.applyOtaUpdate(downloadUrl, version, token || '');
}

export function resetNativeOta() {
  (window as any).ZhiwuNative?.resetOtaUpdate?.();
}
