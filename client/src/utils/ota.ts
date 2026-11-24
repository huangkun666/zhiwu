export const OTA_REPO = 'huangkun666/zhiwu';
export const OTA_REPO_URL = `https://github.com/${OTA_REPO}`;
export const OTA_APK_URL = `${OTA_REPO_URL}/releases/download/latest-ota/zhiwu-android.apk`;
const OTA_INDEX_URL = `https://raw.githubusercontent.com/${OTA_REPO}/ota-index/index.json`;

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

export interface RemoteBranchInfo {
  name: string;
  headSha: string;
  headShortSha: string;
  headMessage: string;
  headDate: string;
  aheadBy: number;
  isCurrent: boolean;
  hasUpdate: boolean;
  headBundle: OtaBuildEntry | null;
  commits: RemoteCommitInfo[];
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

function matchesSha(sha: string, ref: ActiveRefInfo): boolean {
  if (!ref.sha || !sha) return false;
  const a = sha.toLowerCase();
  const b = ref.sha.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a.slice(0, 7));
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
  const native = getNativeOtaState();

  const res = await fetch(`${OTA_INDEX_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`检查更新失败 (${res.status})`);
  }
  const index = await res.json();

  const rawBundles: Record<string, any> = index.bundlesBySha || {};
  const bundlesBySha: Record<string, OtaBuildEntry> = {};
  for (const [k, v] of Object.entries(rawBundles)) {
    const key = k.toLowerCase().slice(0, 7);
    bundlesBySha[key] = {
      shortSha: key,
      sha: v.sha || key,
      branch: v.branch,
      version: v.version,
      nativeVersion: Number(v.nativeVersion || index.latestNativeVersion || 2),
      message: v.message,
      builtAt: v.builtAt || '',
      downloadUrl: v.downloadUrl || `${OTA_REPO_URL}/releases/download/latest-ota/web-bundle-${key}.zip`,
    };
  }

  const rawBranches: any[] = Array.isArray(index.branches) ? index.branches : [];
  if (rawBranches.length === 0) {
    throw new Error('远端暂无可用分支');
  }

  // Build ancestor commit set of current running commit (from whichever branch contains it)
  const currentAncestors = new Set<string>();
  if (currentRef.sha) {
    for (const rb of rawBranches) {
      const list: any[] = rb.commits || [];
      const hitIdx = list.findIndex((c) => matchesSha(String(c.sha || ''), currentRef));
      if (hitIdx >= 0) {
        for (let i = hitIdx; i < list.length; i++) {
          currentAncestors.add(String(list[i].sha || '').toLowerCase());
        }
      }
    }
  }

  const now = Date.now();
  const branches: RemoteBranchInfo[] = rawBranches.map((rb: any) => {
    const rawCommits: any[] = rb.commits || [];
    const commits: RemoteCommitInfo[] = rawCommits.map((c: any, idx: number) => {
      const sha = String(c.sha || '');
      const shortSha = String(c.shortSha || sha.slice(0, 7)).slice(0, 7);
      const bundle = bundlesBySha[shortSha.toLowerCase()] || null;
      const isCurrent = matchesSha(sha, currentRef);
      const date = String(c.date || '');
      const ageMs = date ? now - new Date(date).getTime() : Infinity;
      const isBuildingLikely = !bundle && idx === 0 && ageMs < 6 * 60 * 1000;
      return {
        sha,
        shortSha,
        message: String(c.message || shortSha),
        date,
        author: String(c.author || ''),
        isCurrent,
        bundle,
        needsApkReinstall: Boolean(bundle && bundle.nativeVersion > native.nativeVersion),
        isBuildingLikely,
      };
    });

    const headSha = String(rb.headSha || commits[0]?.sha || '');
    const headShortSha = String(rb.headShortSha || headSha.slice(0, 7)).slice(0, 7);
    const isCurrent = rb.name === currentRef.branch;

    let aheadBy = 0;
    if (!currentRef.sha) {
      aheadBy = commits.length > 0 ? 1 : 0;
    } else if (matchesSha(headSha, currentRef)) {
      aheadBy = 0;
    } else {
      const hitIdx = commits.findIndex((c) => c.isCurrent);
      if (hitIdx > 0) {
        aheadBy = hitIdx;
      } else if (currentAncestors.has(headSha.toLowerCase())) {
        // Branch head is an ancestor of current running commit -> behind, not an update
        aheadBy = 0;
      } else {
        // Diverged branch with commits not in current running history
        const unseen = commits.filter((c) => !currentAncestors.has(c.sha.toLowerCase())).length;
        aheadBy = unseen > 0 ? unseen : 1;
      }
    }

    return {
      name: String(rb.name),
      headSha,
      headShortSha,
      headMessage: String(rb.headMessage || commits[0]?.message || headShortSha),
      headDate: String(rb.headDate || commits[0]?.date || ''),
      aheadBy,
      isCurrent,
      hasUpdate: aheadBy > 0,
      headBundle: bundlesBySha[headShortSha.toLowerCase()] || null,
      commits,
    };
  });

  // Sort: current branch first, then main/master, then branches with updates, then alphabetical
  branches.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if ((a.name === 'main' || a.name === 'master') !== (b.name === 'main' || b.name === 'master')) {
      return a.name === 'main' || a.name === 'master' ? -1 : 1;
    }
    if (a.hasUpdate !== b.hasUpdate) return a.hasUpdate ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const currentBranchInfo = branches.find((b) => b.isCurrent) || branches[0] || null;
  const otherUpdatedBranches = branches.filter((b) => !b.isCurrent && b.hasUpdate);

  return {
    checkedAt: new Date().toISOString(),
    currentRef,
    branches,
    currentBranchInfo,
    otherUpdatedBranches,
    bundlesBySha,
    apkDownloadUrl: index.apkDownloadUrl || OTA_APK_URL,
    latestNativeVersion: Number(index.latestNativeVersion || 2),
  };
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
