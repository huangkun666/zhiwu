import { useEffect, useMemo, useState } from 'react';
import { BookOpen, FileCheck2, MessageSquareText, Network, Target } from 'lucide-react';
import { api } from '../api/client';
import type { GraphLink, GraphNode, PageId } from '../types';

interface GraphPageProps {
  onNavigate: (page: PageId, context?: any) => void;
}

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

function computeLayout(nodes: GraphNode[], links: GraphLink[], width = 760, height = 460): PositionedNode[] {
  if (nodes.length === 0) return [];
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.34;

  const pos = nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, nodes.length);
    return { ...n, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), vx: 0, vy: 0 };
  });

  const byId = new Map(pos.map((p) => [p.id, p]));

  for (let iter = 0; iter < 90; iter++) {
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[j].x - pos[i].x || 0.5;
        const dy = pos[j].y - pos[i].y || 0.5;
        const dist = Math.hypot(dx, dy) || 1;
        const force = 5200 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        pos[i].vx -= fx;
        pos[i].vy -= fy;
        pos[j].vx += fx;
        pos[j].vy += fy;
      }
    }
    for (const l of links) {
      const s = byId.get(l.source);
      const t = byId.get(l.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.hypot(dx, dy) || 1;
      const force = (dist - 125) * 0.04;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      s.vx += fx;
      s.vy += fy;
      t.vx -= fx;
      t.vy -= fy;
    }
    for (const p of pos) {
      p.vx += (cx - p.x) * 0.015;
      p.vy += (cy - p.y) * 0.015;
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x = Math.max(58, Math.min(width - 58, p.x + p.vx));
      p.y = Math.max(46, Math.min(height - 46, p.y + p.vy));
    }
  }
  return pos;
}

export function GraphPage({ onNavigate }: GraphPageProps) {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [weakConcepts, setWeakConcepts] = useState<GraphNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getGraph()
      .then((res) => {
        setNodes(res.nodes);
        setLinks(res.links);
        setWeakConcepts(res.weakConcepts);
        if (res.nodes.length > 0) setSelectedNode(res.weakConcepts[0] || res.nodes[0]);
      })
      .finally(() => setLoading(false));
  }, []);

  const positioned = useMemo(() => computeLayout(nodes, links), [nodes, links]);
  const posMap = useMemo(() => new Map(positioned.map((n) => [n.id, n])), [positioned]);

  const masteryColor = (score: number) => {
    if (score < 0.5) return '#EF4444';
    if (score < 0.75) return '#D97706';
    return '#10B981';
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">知识图谱</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            AI 总结自动构建概念网络，点击任意节点查看掌握度与关联笔记。
          </p>
        </div>
        {weakConcepts.length > 0 && (
          <button
            onClick={() =>
              onNavigate('practice', {
                subTab: 'quiz',
                weakOnly: true,
                focusConcepts: weakConcepts.slice(0, 4).map((w) => w.name),
              })
            }
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
          >
            <Target className="w-3.5 h-3.5" />
            针对薄弱点出题
          </button>
        )}
      </div>

      {loading ? (
        <div className="p-12 text-center text-xs text-[var(--text-muted)]">构建图谱中...</div>
      ) : nodes.length === 0 ? (
        <div className="p-12 rounded-2xl zw-card text-center space-y-2">
          <Network className="w-8 h-8 text-[var(--text-muted)] mx-auto" />
          <p className="text-sm font-medium">知识图谱尚为空</p>
          <p className="text-xs text-[var(--text-muted)]">在笔记库对笔记执行一次「AI 总结」后，概念与脉络将自动生成。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-8 rounded-2xl zw-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
              <span>
                {nodes.length} 个概念 · {links.length} 条关联
              </span>
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)]">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[#6B7280]" /> 待测
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[#EF4444]" /> 薄弱
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[#D97706]" /> 巩固中
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[#10B981]" /> 已掌握
                </span>
              </div>
            </div>

            <div
              className="w-full overflow-x-auto rounded-xl border"
              style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
            >
              <svg viewBox="0 0 760 460" className="w-full min-w-[540px] h-[360px] sm:h-[440px] select-none">
                {links.map((l) => {
                  const s = posMap.get(l.source);
                  const t = posMap.get(l.target);
                  if (!s || !t) return null;
                  const highlighted = selectedNode?.id === s.id || selectedNode?.id === t.id;
                  return (
                    <g key={l.id}>
                      <line
                        x1={s.x}
                        y1={s.y}
                        x2={t.x}
                        y2={t.y}
                        stroke={highlighted ? 'var(--text-primary)' : 'var(--border-strong)'}
                        strokeWidth={highlighted ? 1.8 : 1}
                        strokeOpacity={highlighted ? 0.75 : 0.45}
                        strokeDasharray={l.relation === '同篇共现' ? '4 4' : undefined}
                      />
                      {highlighted && l.relation && l.relation !== '同篇共现' && (
                        <text
                          x={(s.x + t.x) / 2}
                          y={(s.y + t.y) / 2 - 4}
                          textAnchor="middle"
                          fontSize="10"
                          fill="var(--text-secondary)"
                        >
                          {l.relation}
                        </text>
                      )}
                    </g>
                  );
                })}

                {positioned.map((n) => {
                  const isSel = selectedNode?.id === n.id;
                  const r = Math.min(25, 15 + n.note_count * 3);
                  const fill = n.quiz_attempts ? masteryColor(n.mastery_score) : '#6B7280';
                  return (
                    <g key={n.id} onClick={() => setSelectedNode(n)} className="cursor-pointer">
                      {isSel && (
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={r + 6}
                          fill="none"
                          stroke="var(--text-primary)"
                          strokeWidth="1.8"
                          strokeOpacity="0.65"
                        />
                      )}
                      <circle cx={n.x} cy={n.y} r={r} fill={fill} fillOpacity="0.88" />
                      <text x={n.x} y={n.y + 3} textAnchor="middle" fontSize="9.5" fill="#FFFFFF" fontWeight="600">
                        {n.quiz_attempts ? `${Math.round(n.mastery_score * 100)}%` : '待测'}
                      </text>
                      <text
                        x={n.x}
                        y={n.y + r + 15}
                        textAnchor="middle"
                        fontSize="11"
                        fill="var(--text-primary)"
                        fontWeight={isSel ? '600' : '400'}
                      >
                        {n.name}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          <div className="lg:col-span-4 space-y-4">
            {selectedNode && (
              <div className="p-5 rounded-2xl zw-card space-y-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-base">{selectedNode.name}</h3>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {selectedNode.category_name || '通用知识点'}
                    </span>
                  </div>
                  <span
                    className="text-xs font-semibold tabular-nums px-2 py-0.5 rounded-md text-white"
                    style={{ backgroundColor: selectedNode.quiz_attempts ? masteryColor(selectedNode.mastery_score) : '#6B7280' }}
                  >
                    {selectedNode.quiz_attempts ? `${Math.round(selectedNode.mastery_score * 100)}%` : '待测'}
                  </span>
                </div>

                {selectedNode.description && (
                  <p
                    className="text-xs text-[var(--text-secondary)] leading-relaxed p-3 rounded-xl"
                    style={{ background: 'var(--bg-subtle)' }}
                  >
                    {selectedNode.description}
                  </p>
                )}

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
                    <div className="font-semibold tabular-nums">{selectedNode.note_count}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">关联笔记</div>
                  </div>
                  <div className="p-2 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
                    <div className="font-semibold tabular-nums">{selectedNode.quiz_attempts}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">作答次数</div>
                  </div>
                  <div className="p-2 rounded-xl" style={{ background: 'var(--bg-subtle)' }}>
                    <div className="font-semibold tabular-nums" style={{ color: 'var(--danger-fg)' }}>
                      {selectedNode.active_mistakes}
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)]">待克错题</div>
                  </div>
                </div>

                {selectedNode.notes.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-[var(--text-muted)]">出处笔记</div>
                    {selectedNode.notes.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => onNavigate('notes', { noteId: n.id })}
                        className="w-full text-left flex items-center gap-1.5 px-3 py-2 rounded-xl zw-btn-secondary text-xs cursor-pointer"
                      >
                        <BookOpen className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                        <span className="truncate">{n.title}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() =>
                      onNavigate('practice', { subTab: 'quiz', weakOnly: true, focusConcepts: [selectedNode.name] })
                    }
                    className="flex items-center justify-center gap-1 py-2 rounded-xl zw-btn-primary text-xs font-semibold cursor-pointer"
                  >
                    <FileCheck2 className="w-3.5 h-3.5" />
                    专项出题
                  </button>
                  <button
                    onClick={() =>
                      onNavigate('tutor', {
                        mode: 'feynman',
                        noteIds: selectedNode.notes.map((n) => n.id),
                        title: `费曼演练：${selectedNode.name}`,
                        initialPrompt: `我想用费曼学习法向你讲透「${selectedNode.name}」这个概念，请开始考我！`,
                      })
                    }
                    className="flex items-center justify-center gap-1 py-2 rounded-xl zw-btn-secondary text-xs font-medium cursor-pointer"
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                    费曼讲透
                  </button>
                </div>
              </div>
            )}

            <div className="p-5 rounded-2xl zw-card space-y-2.5">
              <h3 className="font-semibold text-sm">薄弱排行</h3>
              <div className="space-y-1.5 max-h-60 overflow-y-auto">
                {weakConcepts.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => setSelectedNode(w)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition cursor-pointer border"
                    style={{
                      background: selectedNode?.id === w.id ? 'var(--bg-active)' : 'var(--bg-subtle)',
                      borderColor: selectedNode?.id === w.id ? 'var(--border-strong)' : 'transparent',
                    }}
                  >
                    <span className="font-medium truncate">{w.name}</span>
                    <span className="font-semibold tabular-nums shrink-0" style={{ color: masteryColor(w.mastery_score) }}>
                      {Math.round(w.mastery_score * 100)}%
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
