export const OTA_REPO = 'huangkun666/zhiwu';
export const OTA_REPO_URL = `https://github.com/${OTA_REPO}`;

export interface NativeOtaState {
  isNative: boolean;
  nativeVersion: number;
  otaVersion: string;
  isOtaActive: boolean;
}

export interface ActiveRefInfo {
  branch: string;
  sha: string;
  shortSha: string;
  version: string;
  isOta: boolean;
}

export interface OtaBuildEntry {
  shortSha: string;
  sha?: string;
  branch?: string;
  version?: string;
  nativeVersion: number;
  message?: string;
  builtAt?: string;
  downloadUrl: string;
}

export interface RemoteBranchInfo {
  name: string;
  headSha: string;
  headShortSha: string;
  headMessage: string;
  headDate: string;
  aheadBy: number;
  behindBy: number;
  isCurrent: boolean;
  hasUpdate: boolean;
  headBundle: OtaBuildEntry | null;
}

export interface RemoteCommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  date: string;
  author: string;
  isCurrent: boolean;
  bundle: OtaBuildEntry | null;
  needsApkReinstall: boolean;
  isBuildingLikely: boolean;
}

export interface UpdateCheckResult {
  checkedAt: string;
  currentRef: ActiveRefInfo;
  branches: RemoteBranchInfo[];
  currentBranchInfo: RemoteBranchInfo | null;
  otherUpdatedBranches: RemoteBranchInfo[];
  bundlesBySha: Record<string, OtaBuildEntry>;
  apkDownloadUrl: string;
  latestNativeVersion: number;
}

const ACTIVE_REF_KEY = 'zhiwu_ota_active_ref';

const BUILTIN_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0';
const BUILTIN_BRANCH = import.meta.env.VITE_APP_BRANCH || 'main';
const BUILTIN_COMMIT = import.meta.env.VITE_APP_COMMIT || '';

export function getNativeOtaState(): NativeOtaState {
  try {
    const raw = (window as any).ZhiwuNative?.getOtaState?.();
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return { isNative: false, nativeVersion: 2, otaVersion: '', isOtaActive: false };
}

export function getCurrentRef(): ActiveRefInfo {
  const native = getNativeOtaState();
  if (native.isOtaActive) {
    try {
      const raw = localStorage.getItem(ACTIVE_REF_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.shortSha) {
          return {
            branch: parsed.branch || BUILTIN_BRANCH,
            sha: parsed.sha || parsed.shortSha,
            shortSha: parsed.shortSha,
            version: parsed.version || native.otaVersion || BUILTIN_VERSION,
            isOta: true,
          };
        }
      }
    } catch {
      // ignore
    }
    const ver = native.otaVersion || BUILTIN_VERSION;
    const parts = ver.split('@');
    if (parts.length === 2) {
      return { branch: parts[0], sha: parts[1], shortSha: parts[1].slice(0, 7), version: ver, isOta: true };
    }
    return {
      branch: BUILTIN_BRANCH,
      sha: BUILTIN_COMMIT,
      shortSha: BUILTIN_COMMIT ? BUILTIN_COMMIT.slice(0, 7) : ver,
      version: ver,
      isOta: true,
    };
  }
  return {
    branch: BUILTIN_BRANCH,
    sha: BUILTIN_COMMIT,
    shortSha: BUILTIN_COMMIT ? BUILTIN_COMMIT.slice(0, 7) : `v${BUILTIN_VERSION}`,
    version: BUILTIN_VERSION,
    isOta: false,
  };
}

function savePendingActiveRef(ref: { branch: string; sha: string; shortSha: string; version: string }) {
  try {
    localStorage.setItem(ACTIVE_REF_KEY, JSON.stringify(ref));
  } catch {
    // ignore
  }
}

async function ghFetchJson(path: string): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${OTA_REPO}${path}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 403) {
    throw new Error('GitHub 接口请求次数达到上限，请稍后再试');
  }
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`远端请求失败 (${res.status})`);
  }
  return res.json();
}

function parseReleaseBundles(rel: any): {
  bundlesBySha: Record<string, OtaBuildEntry>;
  apkDownloadUrl: string;
  latestNativeVersion: number;
} {
  const bundlesBySha: Record<string, OtaBuildEntry> = {};
  let apkDownloadUrl = `${OTA_REPO_URL}/releases/tag/latest-ota`;
  let latestNativeVersion = 2;

  if (!rel) {
    return { bundlesBySha, apkDownloadUrl, latestNativeVersion };
  }

  const body = String(rel.body || '');
  let manifestMap: Record<string, any> = {};

  const buildsMatch = body.match(/<!--ZHIWU_BUILDS:(.*?)-->/);
  if (buildsMatch?.[1]) {
    try {
      manifestMap = JSON.parse(buildsMatch[1]) || {};
    } catch {
      // ignore
    }
  }

  const metaMatch = body.match(/<!--ZHIWU_META:(.*?)-->/);
  if (metaMatch?.[1]) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      if (meta?.nativeVersion) latestNativeVersion = Number(meta.nativeVersion);
    } catch {
      // ignore
    }
  }

  const assets: any[] = rel.assets || [];
  const apkAsset = assets.find((a) => a.name === 'zhiwu-android.apk');
  if (apkAsset?.browser_download_url) {
    apkDownloadUrl = apkAsset.browser_download_url;
  }

  for (const asset of assets) {
    const m = String(asset.name || '').match(/^web-bundle-([0-9a-f]{7,})\.zip$/i);
    if (!m) continue;
    const shortSha = m[1].toLowerCase().slice(0, 7);
    const meta = manifestMap[shortSha] || {};
    bundlesBySha[shortSha] = {
      shortSha,
      sha: meta.sha || shortSha,
      branch: meta.branch,
      version: meta.version,
      nativeVersion: Number(meta.nativeVersion || latestNativeVersion || 2),
      message: meta.message,
      builtAt: meta.builtAt || asset.updated_at || '',
      downloadUrl: asset.browser_download_url,
    };
  }

  return { bundlesBySha, apkDownloadUrl, latestNativeVersion };
}

function firstLine(msg: string): string {
  return String(msg || '').split('\n')[0].trim();
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return '刚刚';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString();
}

export async function checkAllBranchesUpdate(): Promise<UpdateCheckResult> {
  const currentRef = getCurrentRef();

  const [rel, rawBranches] = await Promise.all([
    ghFetchJson('/releases/tags/latest-ota'),
    ghFetchJson('/branches?per_page=20'),
  ]);

  if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
    throw new Error('未获取到远端分支信息');
  }

  const { bundlesBySha, apkDownloadUrl, latestNativeVersion } = parseReleaseBundles(rel);

  // Sort current branch first, then main/master, then alphabetical
  const sortedRaw = [...rawBranches].sort((a, b) => {
    if (a.name === currentRef.branch) return -1;
    if (b.name === currentRef.branch) return 1;
    if (a.name === 'main' || a.name === 'master') return -1;
    if (b.name === 'main' || b.name === 'master') return 1;
    return a.name.localeCompare(b.name);
  });

  // Limit detailed inspection to top 10 branches to stay light on GitHub API quota
  const targetBranches = sortedRaw.slice(0, 10);

  const branches: RemoteBranchInfo[] = await Promise.all(
    targetBranches.map(async (b: any) => {
      const headSha = String(b.commit?.sha || '');
      const headShortSha = headSha.slice(0, 7);
      const isCurrent = b.name === currentRef.branch;
      const headBundle = bundlesBySha[headShortSha.toLowerCase()] || null;

      let aheadBy = 0;
      let behindBy = 0;
      let headMessage = headBundle?.message || '';
      let headDate = headBundle?.builtAt || '';

      const sameAsCurrent =
        Boolean(currentRef.sha) &&
        (headSha === currentRef.sha || headSha.startsWith(currentRef.sha) || currentRef.sha.startsWith(headShortSha));

      if (sameAsCurrent) {
        // Already on this exact commit; fetch commit detail only if message is missing
        if (!headMessage && headSha) {
          const c = await ghFetchJson(`/commits/${headSha}`).catch(() => null);
          headMessage = firstLine(c?.commit?.message || '');
          headDate = c?.commit?.committer?.date || c?.commit?.author?.date || '';
        }
      } else if (currentRef.sha && /^[0-9a-f]{7,40}$/i.test(currentRef.sha)) {
        const cmp = await ghFetchJson(`/compare/${currentRef.sha}...${headSha}`).catch(() => null);
        if (cmp) {
          aheadBy = Number(cmp.ahead_by || 0);
          behindBy = Number(cmp.behind_by || 0);
          const lastCommit = cmp.commits?.[cmp.commits.length - 1];
          if (lastCommit) {
            headMessage = firstLine(lastCommit.commit?.message || '');
            headDate = lastCommit.commit?.committer?.date || lastCommit.commit?.author?.date || '';
          } else {
            const c = await ghFetchJson(`/commits/${headSha}`).catch(() => null);
            headMessage = firstLine(c?.commit?.message || '');
            headDate = c?.commit?.committer?.date || c?.commit?.author?.date || '';
          }
        } else {
          // Unrelated history or unknown base commit
          aheadBy = 1;
          const c = await ghFetchJson(`/commits/${headSha}`).catch(() => null);
          headMessage = firstLine(c?.commit?.message || '');
          headDate = c?.commit?.committer?.date || c?.commit?.author?.date || '';
        }
      } else {
        // Local dev build without embedded commit SHA: treat remote head as newer
        aheadBy = 1;
        const c = await ghFetchJson(`/commits/${headSha}`).catch(() => null);
        headMessage = firstLine(c?.commit?.message || '');
        headDate = c?.commit?.committer?.date || c?.commit?.author?.date || '';
      }

      return {
        name: b.name,
        headSha,
        headShortSha,
        headMessage: headMessage || headShortSha,
        headDate,
        aheadBy,
        behindBy,
        isCurrent,
        hasUpdate: !sameAsCurrent && aheadBy > 0,
        headBundle,
      };
    })
  );

  const currentBranchInfo = branches.find((b) => b.isCurrent) || branches[0] || null;
  const otherUpdatedBranches = branches.filter((b) => !b.isCurrent && b.hasUpdate);

  return {
    checkedAt: new Date().toISOString(),
    currentRef,
    branches,
    currentBranchInfo,
    otherUpdatedBranches,
    bundlesBySha,
    apkDownloadUrl,
    latestNativeVersion,
  };
}

export async function fetchBranchCommits(
  branch: string,
  bundlesBySha: Record<string, OtaBuildEntry>,
  currentRef: ActiveRefInfo
): Promise<RemoteCommitInfo[]> {
  const native = getNativeOtaState();
  const raw = await ghFetchJson(`/commits?sha=${encodeURIComponent(branch)}&per_page=15`);
  if (!Array.isArray(raw)) return [];

  const now = Date.now();
  return raw.map((item: any, idx: number) => {
    const sha = String(item.sha || '');
    const shortSha = sha.slice(0, 7);
    const date = item.commit?.committer?.date || item.commit?.author?.date || '';
    const bundle = bundlesBySha[shortSha.toLowerCase()] || null;
    const isCurrent =
      Boolean(currentRef.sha) &&
      (sha === currentRef.sha || sha.startsWith(currentRef.sha) || currentRef.sha.startsWith(shortSha));
    const ageMs = date ? now - new Date(date).getTime() : Infinity;
    const isBuildingLikely = !bundle && idx === 0 && ageMs < 6 * 60 * 1000;

    return {
      sha,
      shortSha,
      message: firstLine(item.commit?.message || shortSha),
      date,
      author: item.commit?.author?.name || '',
      isCurrent,
      bundle,
      needsApkReinstall: Boolean(bundle && bundle.nativeVersion > native.nativeVersion),
      isBuildingLikely,
    };
  });
}

export function triggerNativeCommitUpdate(
  branch: string,
  commit: RemoteCommitInfo,
  onProgress: (ev: { status: string; message: string }) => void
) {
  if (!commit.bundle) {
    throw new Error('该提交尚未生成构建包');
  }
  const bridge = (window as any).ZhiwuNative;
  if (!bridge?.applyOtaUpdate) {
    throw new Error('请在安卓端应用内执行更新');
  }
  const label = `${branch}@${commit.shortSha}`;
  (window as any).__zhiwuOtaEvent = (ev: { status: string; message: string }) => {
    if (ev.status === 'done') {
      savePendingActiveRef({
        branch,
        sha: commit.sha,
        shortSha: commit.shortSha,
        version: commit.bundle?.version || label,
      });
    }
    onProgress(ev);
  };
  bridge.applyOtaUpdate(commit.bundle.downloadUrl, label, '');
}

export function resetNativeOta() {
  try {
    localStorage.removeItem(ACTIVE_REF_KEY);
  } catch {
    // ignore
  }
  (window as any).ZhiwuNative?.resetOtaUpdate?.();
}
