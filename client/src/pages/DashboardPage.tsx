import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Database,
  Flame,
  Loader2,
  Plus,
  TrendingUp,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import type { DashboardData, PageId } from '../types';

interface DashboardPageProps {
  onNavigate: (page: PageId, context?: any) => void;
  onOpenImport: () => void;
  onRefreshGlobal: () => void;
}

const WELCOME_DISMISSED_KEY = 'zhiwu_welcome_dismissed';

export function DashboardPage({ onNavigate, onOpenImport, onRefreshGlobal }: DashboardPageProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => {
    try {
      return localStorage.getItem(WELCOME_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.getDashboard();
      setData(res);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDismissWelcome = () => {
    setWelcomeDismissed(true);
    try {
      localStorage.setItem(WELCOME_DISMISSED_KEY, '1');
    } catch {
      // ignore
    }
  };

  const handleSeed = async () => {
    setSeeding(true);
    try {
      await api.seedSampleData();
      await load();
      onRefreshGlobal();
    } catch (e: any) {
      alert(e.message || '加载示例数据失败');
    } finally {
      setSeeding(false);
    }
  };

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center h-64 text-xs text-[var(--text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        加载中...
      </div>
    );
  }

  const { stats, heatmap, quizTrend, subjectMastery, weakConcepts, recentNotes } = data;

  const heatVar = (count: number) => {
    if (count <= 0) return 'var(--heat-0)';
    if (count === 1) return 'var(--heat-1)';
    if (count === 2) return 'var(--heat-2)';
    if (count <= 4) return 'var(--heat-3)';
    return 'var(--heat-4)';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">学习概览</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {stats.totalDueReviews > 0
              ? `今日 ${stats.totalDueReviews} 项待复习 · 连续打卡 ${stats.streak} 天`
              : `今日复习已清空 · 连续打卡 ${stats.streak} 天`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onOpenImport}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            导入笔记
          </button>
          <button
            onClick={() => onNavigate('review')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
          >
            <Flame className="w-3.5 h-3.5" />
            开始复习{stats.totalDueReviews > 0 ? ` (${stats.totalDueReviews})` : ''}
          </button>
        </div>
      </div>

      {/* Dismissible Welcome Card */}
      {stats.totalNotes === 0 && !welcomeDismissed && (
        <div className="zw-card rounded-2xl p-5 sm:p-6 relative">
          <button
            onClick={handleDismissWelcome}
            title="关闭引导卡片"
            className="absolute top-3.5 right-3.5 p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pr-7">
            <div className="space-y-1.5">
              <div className="text-sm font-semibold">欢迎使用知悟</div>
              <p className="text-xs text-[var(--text-secondary)] max-w-xl leading-relaxed">
                导入你的 Markdown / PDF / Word 笔记，或前往「设置」填入模型 API Key。也可以一键加载示例数据快速体验图谱、闪卡与热力图。
              </p>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <button
                onClick={handleSeed}
                disabled={seeding}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer disabled:opacity-60"
              >
                {seeding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
                加载示例数据
              </button>
              <button
                onClick={() => onNavigate('settings')}
                className="px-3.5 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
              >
                配置模型
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Monochrome KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <button
          onClick={() => onNavigate('notes')}
          className="text-left p-4 sm:p-5 rounded-2xl zw-card hover:border-[var(--border-strong)] transition cursor-pointer"
        >
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-xs">知识笔记</span>
            <BookOpen className="w-3.5 h-3.5" />
          </div>
          <div className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums mt-2.5">
            {stats.totalNotes}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">已提炼 {stats.summarizedNotes} 篇</div>
        </button>

        <button
          onClick={() => onNavigate('review')}
          className="text-left p-4 sm:p-5 rounded-2xl zw-card hover:border-[var(--border-strong)] transition cursor-pointer"
        >
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-xs">今日待复习</span>
            <Flame className="w-3.5 h-3.5" />
          </div>
          <div className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums mt-2.5">
            {stats.totalDueReviews}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            闪卡 {stats.dueFlashcards} · 错题 {stats.dueMistakes}
          </div>
        </button>

        <button
          onClick={() => onNavigate('practice', { subTab: 'mistakes' })}
          className="text-left p-4 sm:p-5 rounded-2xl zw-card hover:border-[var(--border-strong)] transition cursor-pointer"
        >
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-xs">待攻克错题</span>
            <AlertTriangle className="w-3.5 h-3.5" />
          </div>
          <div className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums mt-2.5">
            {stats.activeMistakes}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">累计收录 {stats.totalMistakes} 题</div>
        </button>

        <div className="p-4 sm:p-5 rounded-2xl zw-card">
          <div className="flex items-center justify-between text-[var(--text-muted)]">
            <span className="text-xs">打卡与正确率</span>
            <TrendingUp className="w-3.5 h-3.5" />
          </div>
          <div className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums mt-2.5">
            {stats.streak}
            <span className="text-xs font-normal text-[var(--text-muted)] ml-1">天</span>
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            {stats.avgAccuracy !== null ? `测验正确率 ${stats.avgAccuracy}%` : `今日学习 ${stats.todayActions} 次`}
          </div>
        </div>
      </div>

      {/* Heatmap & Accuracy Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 p-5 rounded-2xl zw-card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-sm">学习热力图</h3>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">近 16 周导入、总结、测验与复习轨迹</p>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
              <span>少</span>
              {[0, 1, 2, 3, 4].map((lv) => (
                <span
                  key={lv}
                  className="w-2.5 h-2.5 rounded-[3px]"
                  style={{ background: `var(--heat-${lv})` }}
                />
              ))}
              <span>多</span>
            </div>
          </div>
          <div className="overflow-x-auto pb-1">
            <div className="grid grid-flow-col grid-rows-7 gap-1.5 min-w-[440px]">
              {heatmap.map((cell) => (
                <div
                  key={cell.date}
                  title={`${cell.date}：${cell.count} 次学习`}
                  className="w-4 h-4 rounded-[4px] transition-opacity hover:opacity-80"
                  style={{ background: heatVar(cell.count) }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="p-5 rounded-2xl zw-card flex flex-col">
          <h3 className="font-semibold text-sm">测验正确率趋势</h3>
          <p className="text-[11px] text-[var(--text-muted)] mt-0.5 mb-4">按日统计动态出题得分</p>
          {quizTrend.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-muted)] py-8 text-center">
              完成一次测验后自动绘制
            </div>
          ) : (
            <div className="flex-1 flex items-end gap-2 pt-4 min-h-[120px]">
              {quizTrend.map((pt) => (
                <div key={pt.date} className="flex-1 flex flex-col items-center gap-1.5">
                  <span className="text-[10px] font-medium tabular-nums text-[var(--text-secondary)]">
                    {Math.round(pt.accuracy)}%
                  </span>
                  <div
                    className="w-full rounded-t-md h-24 flex items-end overflow-hidden"
                    style={{ background: 'var(--bg-subtle)' }}
                  >
                    <div
                      className="w-full rounded-t-md transition-all"
                      style={{
                        height: `${Math.max(8, pt.accuracy)}%`,
                        background: 'var(--btn-primary-bg)',
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)]">{pt.date.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Row: Subject Mastery + Weak Points + Recent Notes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="p-5 rounded-2xl zw-card">
          <h3 className="font-semibold text-sm mb-3.5">学科掌握度</h3>
          {subjectMastery.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] py-6 text-center">暂无已分类的笔记</p>
          ) : (
            <div className="space-y-3.5">
              {subjectMastery.map((sub) => (
                <div key={sub.id}>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="font-medium">{sub.name}</span>
                    <span className="text-[var(--text-muted)] tabular-nums">
                      {sub.mastery === null ? '待提炼' : `${sub.mastery}%`} · {sub.note_count} 篇
                    </span>
                  </div>
                  {sub.mastery !== null && (
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-subtle)' }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${sub.mastery}%`, background: 'var(--btn-primary-bg)' }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-5 rounded-2xl zw-card">
          <div className="flex items-center justify-between mb-3.5">
            <h3 className="font-semibold text-sm">薄弱知识点</h3>
            {weakConcepts.length > 0 && (
              <button
                onClick={() => onNavigate('practice', { subTab: 'quiz', weakOnly: true })}
                className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                专项突破 →
              </button>
            )}
          </div>
          {weakConcepts.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] py-6 text-center">总结笔记并测验后自动识别</p>
          ) : (
            <div className="space-y-2">
              {weakConcepts.map((c) => {
                const pct = Math.round(c.mastery_score * 100);
                const badgeStyle =
                  pct < 50
                    ? { background: 'var(--danger-bg)', color: 'var(--danger-fg)' }
                    : pct < 75
                    ? { background: 'var(--warn-bg)', color: 'var(--warn-fg)' }
                    : { background: 'var(--ok-bg)', color: 'var(--ok-fg)' };
                return (
                  <div
                    key={c.id}
                    className="flex items-center justify-between px-3 py-2.5 rounded-xl border"
                    style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
                  >
                    <div>
                      <div className="text-xs font-medium">{c.name}</div>
                      <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                        {c.quiz_correct}/{c.quiz_attempts} 正确
                      </div>
                    </div>
                    <span className="text-[11px] font-semibold tabular-nums px-2 py-0.5 rounded-md" style={badgeStyle}>
                      {pct}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-5 rounded-2xl zw-card">
          <div className="flex items-center justify-between mb-3.5">
            <h3 className="font-semibold text-sm">最近更新</h3>
            <button
              onClick={() => onNavigate('notes')}
              className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              全部 →
            </button>
          </div>
          {recentNotes.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] py-6 text-center">暂无笔记</p>
          ) : (
            <div className="space-y-1.5">
              {recentNotes.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onNavigate('notes', { noteId: n.id })}
                  className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-[var(--bg-hover)] transition flex items-center justify-between gap-2 cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{n.title}</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                      {n.category_name || '未分类'} · {new Date(n.updated_at).toLocaleDateString()}
                    </div>
                  </div>
                  {n.has_summary ? (
                    <span
                      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
                    >
                      已总结
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
