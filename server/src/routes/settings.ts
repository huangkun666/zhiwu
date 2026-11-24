import { Router } from 'express';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { type AISettings, DB_PATH, PROJECT_ROOT, getAISettings, nowIso, saveAISettings } from '../db.js';
import { fetchProviderModels, getActiveModelCapability, testProviderConnection } from '../services/ai.js';
import { restoreLegacyBackup } from '../services/backupArchive.js';
import { readBackupSnapshot } from '../services/backupSnapshot.js';

export const settingsRouter = Router();

export interface NetworkAdapterInfo {
  name: string;
  address: string;
  isVirtual: boolean;
}

const VIRTUAL_PATTERN = /vmware|vmnet|virtualbox|vbox|vethernet|wsl|hyper-v|docker|tailscale|zerotier|tun|tap|loopback/i;
const WIFI_ETH_PATTERN = /wlan|wi-fi|wifi|ethernet|以太网|无线|en0|eth0/i;

export function getLocalNetworkAdapters(): NetworkAdapterInfo[] {
  const nets = os.networkInterfaces();
  const list: NetworkAdapterInfo[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        list.push({
          name,
          address: net.address,
          isVirtual: VIRTUAL_PATTERN.test(name),
        });
      }
    }
  }
  return list.sort((a, b) => {
    const score = (x: NetworkAdapterInfo) => {
      if (!x.isVirtual && WIFI_ETH_PATTERN.test(x.name)) return 0;
      if (!x.isVirtual) return 1;
      if (/tailscale/i.test(x.name)) return 2;
      return 3;
    };
    return score(a) - score(b);
  });
}

export function getLocalIPv4Addresses(): string[] {
  return getLocalNetworkAdapters().map((a) => a.address);
}

settingsRouter.get('/', (_req, res) => {
  res.json({
    ...getAISettings(),
    activeCapability: getActiveModelCapability(),
  });
});

settingsRouter.get('/mcp', (req, res) => {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const sameMachine = loopback.includes(req.socket.remoteAddress || '') && [...loopback, '[::1]', 'localhost'].includes(req.hostname || '');
  res.json({ adapterPath: sameMachine ? path.join(PROJECT_ROOT, 'server', 'mcp.mjs') : null });
});

settingsRouter.put('/', (req, res) => {
  const body = req.body as Partial<AISettings>;
  const current = getAISettings();
  const updated: AISettings = {
    activeProviderId: body.activeProviderId || current.activeProviderId,
    providers: Array.isArray(body.providers) && body.providers.length > 0 ? body.providers : current.providers,
    dailyGoalMinutes: Number(body.dailyGoalMinutes) || current.dailyGoalMinutes,
    dailyReviewTarget: Number(body.dailyReviewTarget) || current.dailyReviewTarget,
  };
  saveAISettings(updated);
  res.json({
    ...updated,
    activeCapability: getActiveModelCapability(),
  });
});

settingsRouter.post('/test-ai', async (req, res) => {
  const { provider } = req.body || {};
  if (!provider) return res.status(400).json({ error: '缺少模型配置参数' });
  try {
    const result = await testProviderConnection(provider);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || '连接测试失败' });
  }
});

// Fetch live model list from remote or local endpoint
settingsRouter.post('/models', async (req, res) => {
  const { provider } = req.body || {};
  if (!provider) return res.status(400).json({ error: '缺少模型配置参数' });
  try {
    const models = await fetchProviderModels(provider);
    res.json({ ok: true, models });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || '获取模型列表失败' });
  }
});

// Network info & QR code for Android mobile LAN pairing
settingsRouter.get('/network', async (req, res) => {
  const adapters = getLocalNetworkAdapters();
  const ips = adapters.map((a) => a.address);
  const reqPort = String(req.query.port || process.env.PORT || '3001');
  const requestedIp = String(req.query.ip || '').trim();
  const primaryIp = ips.includes(requestedIp) ? requestedIp : adapters[0]?.address || '127.0.0.1';
  const mobileUrl = `http://${primaryIp}:${reqPort}`;

  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      width: 240,
      margin: 2,
      color: { dark: '#1C1B18', light: '#FFFFFF' },
    });
  } catch {
    // ignore
  }

  res.json({
    adapters,
    ips,
    primaryIp,
    port: reqPort,
    mobileUrl,
    qrDataUrl,
  });
});

// Download SQLite database backup
settingsRouter.get('/backup', (_req, res) => {
  res.download(DB_PATH, `zhiwu-backup-${new Date().toISOString().slice(0, 10)}.db`);
});

// Compatibility with older clients and saved JSON backups.
settingsRouter.get('/export-json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: 1, exportedAt: nowIso(), ...readBackupSnapshot() });
});

settingsRouter.post('/import-json', async (req, res) => {
  try {
    res.json(await restoreLegacyBackup(req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : '无法读取知悟 JSON 备份' });
  }
});
