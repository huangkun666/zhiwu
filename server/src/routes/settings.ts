import { Router } from 'express';
import os from 'node:os';
import QRCode from 'qrcode';
import {
  AISettings,
  countWords,
  db,
  DB_PATH,
  getAISettings,
  nowIso,
  saveAISettings,
  syncNoteFts,
  uid,
  upsertConcept,
} from '../db.js';
import { fetchProviderModels, getActiveModelCapability, testProviderConnection } from '../services/ai.js';

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

// Unified Cross-Device JSON Export (100% compatible with Android APK standalone backup!)
settingsRouter.get('/export-json', (_req, res) => {
  const categories = db.prepare(`SELECT * FROM categories`).all();
  const notes = (db.prepare(`SELECT * FROM notes`).all() as any[]).map((n) => ({
    ...n,
    tags: JSON.parse(n.tags || '[]'),
    summary: n.summary_json ? JSON.parse(n.summary_json) : null,
    is_pinned: Boolean(n.is_pinned),
  }));
  const syntheses = (db.prepare(`SELECT * FROM syntheses`).all() as any[]).map((s) => ({
    ...s,
    note_ids: JSON.parse(s.note_ids || '[]'),
  }));
  const concepts = (db.prepare(`SELECT * FROM concepts`).all() as any[]).map((c) => {
    const noteIds = (
      db.prepare(`SELECT note_id FROM note_concepts WHERE concept_id = ?`).all(c.id) as { note_id: string }[]
    ).map((r) => r.note_id);
    return { ...c, note_ids: noteIds };
  });
  const conceptLinks = db
    .prepare(`SELECT id, source_id as source, target_id as target, relation, weight FROM concept_links`)
    .all();
  const flashcards = db.prepare(`SELECT * FROM flashcards`).all();
  const mistakes = (db.prepare(`SELECT * FROM mistakes`).all() as any[]).map((m) => ({
    ...m,
    options: JSON.parse(m.options_json || '[]'),
  }));
  const studyLogs = db.prepare(`SELECT * FROM study_logs`).all();

  res.json({
    version: 1,
    exportedAt: nowIso(),
    categories,
    notes,
    syntheses,
    concepts,
    conceptLinks,
    flashcards,
    mistakes,
    studyLogs,
  });
});

// Unified Cross-Device JSON Smart Merge Import (Desktop <-> Android APK sync!)
settingsRouter.post('/import-json', (req, res) => {
  const payload = req.body || {};
  if (!Array.isArray(payload.notes)) {
    return res.status(400).json({ error: '无效的知悟 JSON 备份格式' });
  }

  let notesMerged = 0;
  let cardsMerged = 0;
  let mistakesMerged = 0;
  const now = nowIso();

  for (const c of payload.categories || []) {
    if (!c?.id || !c?.name) continue;
    db.prepare(
      `INSERT OR IGNORE INTO categories (id, name, color, icon, description, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(c.id, c.name, c.color || '#3B5BDB', c.icon || 'folder', c.description || '', c.created_at || now);
  }

  for (const n of payload.notes || []) {
    if (!n?.id || !n?.title) continue;
    const existing = db.prepare(`SELECT updated_at FROM notes WHERE id = ?`).get(n.id) as
      | { updated_at: string }
      | undefined;
    const incomingUpdated = n.updated_at || now;
    if (!existing || incomingUpdated > existing.updated_at) {
      const tags = Array.isArray(n.tags) ? n.tags : [];
      db.prepare(
        `INSERT OR REPLACE INTO notes (
          id, title, content, summary_json, category_id, tags, source_type, source_filename,
          attachment_path, word_count, is_pinned, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        n.id,
        n.title,
        n.content || '',
        n.summary ? JSON.stringify(n.summary) : null,
        n.category_id || null,
        JSON.stringify(tags),
        n.source_type || 'markdown',
        n.source_filename || null,
        n.attachment_path || null,
        n.word_count || countWords(n.content || ''),
        n.is_pinned ? 1 : 0,
        n.created_at || now,
        incomingUpdated
      );
      syncNoteFts(n.id, n.title, n.content || '', tags);
      notesMerged++;
    }
  }

  for (const s of payload.syntheses || []) {
    if (!s?.id || !s?.content) continue;
    db.prepare(
      `INSERT OR IGNORE INTO syntheses (id, title, note_ids, category_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(s.id, s.title || '专题归纳', JSON.stringify(s.note_ids || []), s.category_id || null, s.content, s.created_at || now);
  }

  for (const con of payload.concepts || []) {
    if (!con?.name) continue;
    const cid = upsertConcept(con.name, con.description || '', con.category_id || null);
    for (const nid of con.note_ids || []) {
      try {
        db.prepare(`INSERT OR IGNORE INTO note_concepts (note_id, concept_id) VALUES (?, ?)`).run(nid, cid);
      } catch {
        // note may not exist
      }
    }
  }

  for (const f of payload.flashcards || []) {
    if (!f?.id || !f?.front || !f?.back) continue;
    db.prepare(
      `INSERT OR IGNORE INTO flashcards (
        id, note_id, category_id, concept_name, front, back, hint,
        ease_factor, interval_days, repetitions, next_review_at, last_reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      f.id,
      f.note_id || null,
      f.category_id || null,
      f.concept_name || '',
      f.front,
      f.back,
      f.hint || '',
      f.ease_factor || 2.5,
      f.interval_days || 0,
      f.repetitions || 0,
      f.next_review_at || now,
      f.last_reviewed_at || null,
      f.created_at || now,
      f.updated_at || now
    );
    cardsMerged++;
  }

  for (const m of payload.mistakes || []) {
    if (!m?.id || !m?.stem) continue;
    db.prepare(
      `INSERT OR IGNORE INTO mistakes (
        id, question_id, note_id, concept_name, type, stem, options_json,
        correct_answer, wrong_answer, explanation, ai_diagnosis, user_reflection,
        status, wrong_count, ease_factor, interval_days, repetitions,
        next_review_at, last_reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      m.id,
      m.question_id || null,
      m.note_id || null,
      m.concept_name || '',
      m.type || 'single',
      m.stem,
      JSON.stringify(m.options || []),
      m.correct_answer || '',
      m.wrong_answer || '',
      m.explanation || '',
      m.ai_diagnosis || '',
      m.user_reflection || '',
      m.status || 'unmastered',
      m.wrong_count || 1,
      m.ease_factor || 2.5,
      m.interval_days || 1,
      m.repetitions || 0,
      m.next_review_at || now,
      m.last_reviewed_at || null,
      m.created_at || now,
      m.updated_at || now
    );
    mistakesMerged++;
  }

  for (const l of payload.studyLogs || []) {
    if (!l?.activity_type || !l?.date_key) continue;
    db.prepare(
      `INSERT OR IGNORE INTO study_logs (id, activity_type, entity_id, duration_seconds, score, created_at, date_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(l.id || uid(), l.activity_type, l.entity_id || null, l.duration_seconds || 0, l.score ?? null, l.created_at || now, l.date_key);
  }

  res.json({ ok: true, notesCount: notesMerged, cardsMerged, mistakesMerged });
});
