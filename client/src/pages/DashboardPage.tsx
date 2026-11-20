import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Database,
  Flame,
  Loader2,
  Plus,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { api } from '../api/client';
import type { DashboardData, PageId } from '../types';

interface DashboardPageProps {
  onNavigate: (page: PageId, context?: any) => void;
  onOpenImport: () => void;
  onRefreshGlobal: () => void;
}

export function DashboardPage({ onNavigate, onOpenImport, onRefreshGlobal }: DashboardPageProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

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
      <div className="flex items-center justify-center h-64 text-[#7A756C]">
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
        正在加载学习看板...
      </div>
    );
  }

  const { stats, heatmap, quizTrend, subjectMastery, weakConcepts, recentNotes } = data;

  const heatColor = (count: number) => {
    if (count <= 0) return 'bg-[#EFECE6]';
    if (count === 1) return 'bg-[#C7D2FE]';
    if (count === 2) return 'bg-[#818CF8]';
    if (count <= 4) return 'bg-[#4F46E5]';
    return 'bg-[#312E81]';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#141311] tracking-tight">学习看板</h1>
          <p className="text-sm text-[#6F6B63] mt-0.5">
            {stats.totalDueReviews > 0
              ? `今天有 ${stats.totalDueReviews} 项待复习内容，趁遗忘临界点巩固效果最好。`
              : '今日复习已清空，导入新笔记或来一轮动态出题吧！'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onOpenImport}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#3B5BDB] text-white text-sm font-semibold hover:bg-[#2F4AC2] shadow-sm transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            导入笔记
          </button>
          <button
            onClick={() => onNavigate('review')}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white border border-[#E5E2DC] text-[#1C1B18] text-sm font-semibold hover:bg-[#F5F3EE] transition cursor-pointer"
          >
            <Flame className="w-4 h-4 text-amber-500" />
            开始复习 {stats.totalDueReviews > 0 ? `(${stats.totalDueReviews})` : ''}
          </button>
        </div>
      </div>

      {/* Empty State Onboarding Banner */}
      {stats.totalNotes === 0 && (
        <div className="rounded-2xl bg-gradient-to-br from-[#F3F5FC] via-white to-[#EEF8F6] border border-[#3B5BDB]/20 p-5 sm:p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#3B5BDB] bg-white px-2.5 py-1 rounded-full border border-[#3B5BDB]/20">
                <Sparkles className="w-3.5 h-3.5" />
                欢迎来到「知悟」个人学习空间
              </div>
              <h2 className="text-lg font-bold text-[#141311]">立刻开始你的知识内化闭环</h2>
              <p className="text-sm text-[#524F49] max-w-2xl">
                你可以直接导入自己的 Markdown / PDF / Word / 拍照笔记，或在「设置」中填入 DeepSeek / 通义千问 / Gemini / 本地 Ollama 模型。也可以先一键加载示例学习数据，即刻体验图谱、闪卡、错题本与热力图！
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5 shrink-0">
              <button
                onClick={handleSeed}
                disabled={seeding}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0F766E] text-white text-sm font-semibold hover:bg-[#0D625B] transition cursor-pointer disabled:opacity-60"
              >
                {seeding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                一键加载示例数据
              </button>
              <button
                onClick={() => onNavigate('settings')}
                className="px-4 py-2.5 rounded-xl bg-white border border-[#DDD8CE] text-sm font-semibold text-[#1C1B18] hover:bg-[#F5F3EE] transition cursor-pointer"
              >
                配置 AI 模型
              </button>
            </div>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <button
          onClick={() => onNavigate('notes')}
          className="text-left p-4 sm:p-5 rounded-2xl bg-white border border-[#EAE6DF] hover:border-[#3B5BDB]/40 transition shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
        >
          <div className="flex items-center justify-between text-[#6F6B63]">
            <span className="text-xs font-medium">知识笔记</span>
            <BookOpen className="w-4 h-4 text-[#3B5BDB]" />
          </div>
          <div className="text-2xl sm:text-3xl font-bold text-[#141311] mt-2">{stats.totalNotes}</div>
          <div className="text-xs text-[#8A857C] mt-1">已 AI 总结 {stats.summarizedNotes} 篇</div>
        </button>

        <button
          onClick={() => onNavigate('review')}
          className="text-left p-4 sm:p-5 rounded-2xl bg-white border border-[#EAE6DF] hover:border-amber-400 transition shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
        >
          <div className="flex items-center justify-between text-[#6F6B63]">
            <span className="text-xs font-medium">今日待复习</span>
            <Flame className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl sm:text-3xl font-bold text-[#141311] mt-2">{stats.totalDueReviews}</div>
          <div className="text-xs text-[#8A857C] mt-1">
            闪卡 {stats.dueFlashcards} · 错题 {stats.dueMistakes}
          </div>
        </button>

        <button
          onClick={() => onNavigate('practice', { subTab: 'mistakes' })}
          className="text-left p-4 sm:p-5 rounded-2xl bg-white border border-[#EAE6DF] hover:border-red-300 transition shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
        >
          <div className="flex items-center justify-between text-[#6F6B63]">
            <span className="text-xs font-medium">待攻克错题</span>
            <AlertTriangle className="w-4 h-4 text-red-500" />
          </div>
          <div className="text-2xl sm:text-3xl font-bold text-[#141311] mt-2">{stats.activeMistakes}</div>
          <div className="text-xs text-[#8A857C] mt-1">累计收录 {stats.totalMistakes} 题</div>
        </button>

        <div className="p-4 sm:p-5 rounded-2xl bg-white border border-[#EAE6DF] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between text-[#6F6B63]">
            <span className="text-xs font-medium">连续打卡 / 正确率</span>
            <TrendingUp className="w-4 h-4 text-[#0F766E]" />
          </div>
          <div className="text-2xl sm:text-3xl font-bold text-[#141311] mt-2">
            {stats.streak}
            <span className="text-sm font-normal text-[#7A756C] ml-1">天</span>
          </div>
          <div className="text-xs text-[#8A857C] mt-1">
            {stats.avgAccuracy !== null ? `测验平均正确率 ${stats.avgAccuracy}%` : `今日已学习 ${stats.todayActions} 次`}
          </div>
        </div>
      </div>

      {/* Heatmap & Accuracy Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 p-5 rounded-2xl bg-white border border-[#EAE6DF]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-bold text-sm text-[#141311]">近 16 周学习热力图</h3>
              <p className="text-xs text-[#8A857C]">记录笔记导入、总结、测验与间隔复习轨迹</p>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-[#8A857C]">
              <span>少</span>
              <span className="w-2.5 h-2.5 rounded-sm bg-[#EFECE6]" />
              <span className="w-2.5 h-2.5 rounded-sm bg-[#C7D2FE]" />
              <span className="w-2.5 h-2.5 rounded-sm bg-[#818CF8]" />
              <span className="w-2.5 h-2.5 rounded-sm bg-[#4F46E5]" />
              <span>多</span>
            </div>
          </div>
          <div className="overflow-x-auto pb-1">
            <div className="grid grid-flow-col grid-rows-7 gap-1.5 min-w-[440px]">
              {heatmap.map((cell) => (
                <div
                  key={cell.date}
                  title={`${cell.date}：${cell.count} 次学习记录`}
                  className={`w-4 h-4 sm:w-4.5 sm:h-4.5 rounded-[4px] ${heatColor(cell.count)} transition hover:ring-2 hover:ring-[#3B5BDB]/50`}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Quiz Accuracy Trend */}
        <div className="p-5 rounded-2xl bg-white border border-[#EAE6DF] flex flex-col">
          <h3 className="font-bold text-sm text-[#141311] mb-1">近期做题正确率趋势</h3>
          <p className="text-xs text-[#8A857C] mb-4">按日统计动态出题平均正确率</p>
          {quizTrend.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-[#9C978E] text-center py-8">
              完成一次动态出题后将自动绘制趋势图
            </div>
          ) : (
            <div className="flex-1 flex items-end gap-2 pt-4 min-h-[120px]">
              {quizTrend.map((pt) => (
                <div key={pt.date} className="flex-1 flex flex-col items-center gap-1.5">
                  <span className="text-[10px] font-semibold text-[#3B5BDB]">{Math.round(pt.accuracy)}%</span>
                  <div className="w-full bg-[#F3F5FC] rounded-t-lg h-24 flex items-end overflow-hidden">
                    <div
                      className="w-full bg-gradient-to-t from-[#3B5BDB] to-[#6B85F5] rounded-t-lg transition-all"
                      style={{ height: `${Math.max(8, pt.accuracy)}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-[#8A857C]">{pt.date.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Row: Subject Mastery + Weak Concepts + Recent Notes */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Subject Mastery */}
        <div className="p-5 rounded-2xl bg-white border border-[#EAE6DF]">
          <h3 className="font-bold text-sm text-[#141311] mb-3">学科掌握度</h3>
          {subjectMastery.length === 0 ? (
            <p className="text-xs text-[#8A857C] py-6 text-center">暂无分类数据</p>
          ) : (
            <div className="space-y-3">
              {subjectMastery.map((sub) => (
                <div key={sub.id}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium text-[#2A2824] flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: sub.color || '#3B5BDB' }} />
                      {sub.name}
                    </span>
                    <span className="text-[#6F6B63]">
                      {sub.mastery}% · {sub.note_count} 篇
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-[#F1EFEA] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${sub.mastery}%`, backgroundColor: sub.color || '#3B5BDB' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Weak Points Diagnosis */}
        <div className="p-5 rounded-2xl bg-white border border-[#EAE6DF]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-sm text-[#141311]">薄弱知识点预警</h3>
            <button
              onClick={() => onNavigate('practice', { subTab: 'quiz', weakOnly: true })}
              className="text-xs font-semibold text-[#3B5BDB] hover:underline cursor-pointer"
            >
              专项出题 →
            </button>
          </div>
          {weakConcepts.length === 0 ? (
            <p className="text-xs text-[#8A857C] py-6 text-center">AI 总结笔记并做题后自动识别薄弱项</p>
          ) : (
            <div className="space-y-2.5">
              {weakConcepts.map((c) => {
                const pct = Math.round(c.mastery_score * 100);
                return (
                  <div
                    key={c.id}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-[#FAF9F6] border border-[#EFECE6]"
                  >
                    <div>
                      <div className="text-xs font-semibold text-[#1C1B18]">{c.name}</div>
                      <div className="text-[11px] text-[#8A857C]">
                        练习 {c.quiz_attempts} 次 · 正确 {c.quiz_correct} 次
                      </div>
                    </div>
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded-lg ${
                        pct < 50
                          ? 'bg-red-100 text-red-700'
                          : pct < 75
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {pct}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Notes */}
        <div className="p-5 rounded-2xl bg-white border border-[#EAE6DF]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-sm text-[#141311]">最近更新笔记</h3>
            <button
              onClick={() => onNavigate('notes')}
              className="text-xs font-semibold text-[#3B5BDB] hover:underline cursor-pointer"
            >
              查看全部 →
            </button>
          </div>
          {recentNotes.length === 0 ? (
            <p className="text-xs text-[#8A857C] py-6 text-center">还没有笔记，点击上方「导入笔记」开始吧</p>
          ) : (
            <div className="space-y-2">
              {recentNotes.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onNavigate('notes', { noteId: n.id })}
                  className="w-full text-left p-2.5 rounded-xl hover:bg-[#F5F3EE] transition flex items-center justify-between gap-2 cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#1C1B18] truncate">{n.title}</div>
                    <div className="text-[11px] text-[#8A857C] mt-0.5">
                      {n.category_name || '未分类'} · {new Date(n.updated_at).toLocaleDateString()}
                    </div>
                  </div>
                  {n.has_summary ? (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[#F3F5FC] text-[#3B5BDB] font-medium">
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
