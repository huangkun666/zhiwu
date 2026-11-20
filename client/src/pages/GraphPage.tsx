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

  // Deterministic circular initialization
  const pos = nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, nodes.length);
    return {
      ...n,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      vx: 0,
      vy: 0,
    };
  });

  const byId = new Map(pos.map((p) => [p.id, p]));

  // Lightweight spring-repulsion relaxation (90 iterations -> super fast, crisp layout)
  for (let iter = 0; iter < 90; iter++) {
    // Repulsion between all nodes
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

    // Spring attraction along links
    for (const l of links) {
      const s = byId.get(l.source);
      const t = byId.get(l.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ideal = 125;
      const force = (dist - ideal) * 0.04;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      s.vx += fx;
      s.vy += fy;
      t.vx -= fx;
      t.vy -= fy;
    }

    // Gentle center gravity + damping + bounds
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
    if (score < 0.5) return '#DC2626';
    if (score < 0.75) return '#D97706';
    return '#0F766E';
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#141311]">知识图谱与薄弱项诊断</h1>
          <p className="text-xs text-[#7A756C] mt-0.5">
            AI 总结笔记自动构建概念关联网络，节点颜色实时反映你的测验掌握度。
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
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold hover:bg-[#2F4AC2] cursor-pointer"
          >
            <Target className="w-4 h-4" />
            针对薄弱点一键出题
          </button>
        )}
      </div>

      {loading ? (
        <div className="p-12 text-center text-sm text-[#8A857C]">正在构建知识图谱...</div>
      ) : nodes.length === 0 ? (
        <div className="p-12 rounded-2xl bg-white border border-[#EAE6DF] text-center space-y-2">
          <Network className="w-10 h-10 text-[#C7C2B8] mx-auto" />
          <p className="text-sm font-semibold text-[#1C1B18]">知识图谱尚在孕育中</p>
          <p className="text-xs text-[#8A857C]">
            在「笔记库」中对笔记执行一次「AI 总结与提炼」，系统会自动抽取核心概念与逻辑关系并绘制图谱。
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Interactive SVG Graph Canvas */}
          <div className="lg:col-span-8 rounded-2xl bg-white border border-[#EAE6DF] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[#4A4741]">
                共 {nodes.length} 个核心知识点 · {links.length} 条知识关联（点击节点查看详情）
              </span>
              <div className="flex items-center gap-3 text-[11px] text-[#6F6B63]">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#DC2626]" /> 薄弱 (&lt;50%)
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#D97706]" /> 巩固中
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#0F766E]" /> 已掌握 (≥75%)
                </span>
              </div>
            </div>

            <div className="w-full overflow-x-auto rounded-xl bg-[#FAF9F6] border border-[#EFECE6]">
              <svg viewBox="0 0 760 460" className="w-full min-w-[540px] h-[360px] sm:h-[440px] select-none">
                {/* Edges */}
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
                        stroke={highlighted ? '#3B5BDB' : '#D4CFC5'}
                        strokeWidth={highlighted ? 2.2 : 1.2}
                        strokeDasharray={l.relation === '同篇共现' ? '4 4' : undefined}
                      />
                      {highlighted && l.relation && l.relation !== '同篇共现' && (
                        <text
                          x={(s.x + t.x) / 2}
                          y={(s.y + t.y) / 2 - 4}
                          textAnchor="middle"
                          fontSize="10"
                          fill="#3B5BDB"
                          fontWeight="600"
                        >
                          {l.relation}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Nodes */}
                {positioned.map((n) => {
                  const isSel = selectedNode?.id === n.id;
                  const r = Math.min(26, 15 + n.note_count * 3);
                  const fill = masteryColor(n.mastery_score);
                  return (
                    <g
                      key={n.id}
                      onClick={() => setSelectedNode(n)}
                      className="cursor-pointer"
                    >
                      {isSel && (
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={r + 6}
                          fill="none"
                          stroke="#3B5BDB"
                          strokeWidth="2.5"
                          strokeOpacity="0.6"
                        />
                      )}
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={r}
                        fill={fill}
                        fillOpacity="0.92"
                        stroke="#FFFFFF"
                        strokeWidth="2.5"
                      />
                      <text
                        x={n.x}
                        y={n.y + 3}
                        textAnchor="middle"
                        fontSize="10"
                        fill="#FFFFFF"
                        fontWeight="700"
                      >
                        {Math.round(n.mastery_score * 100)}%
                      </text>
                      <text
                        x={n.x}
                        y={n.y + r + 15}
                        textAnchor="middle"
                        fontSize="11.5"
                        fill="#1C1B18"
                        fontWeight={isSel ? '700' : '500'}
                      >
                        {n.name}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          {/* Right Inspector & Weak Diagnosis */}
          <div className="lg:col-span-4 space-y-4">
            {selectedNode && (
              <div className="p-5 rounded-2xl bg-white border border-[#EAE6DF] space-y-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-base text-[#141311]">{selectedNode.name}</h3>
                    <span className="text-[11px] text-[#8A857C]">
                      {selectedNode.category_name || '通用知识点'}
                    </span>
                  </div>
                  <span
                    className="text-xs font-bold px-2.5 py-1 rounded-lg text-white"
                    style={{ backgroundColor: masteryColor(selectedNode.mastery_score) }}
                  >
                    掌握度 {Math.round(selectedNode.mastery_score * 100)}%
                  </span>
                </div>

                {selectedNode.description && (
                  <p className="text-xs text-[#4A4741] leading-relaxed bg-[#FAF9F6] p-3 rounded-xl">
                    {selectedNode.description}
                  </p>
                )}

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2 rounded-xl bg-[#FAF9F6]">
                    <div className="font-bold text-[#141311]">{selectedNode.note_count}</div>
                    <div className="text-[10px] text-[#8A857C]">关联笔记</div>
                  </div>
                  <div className="p-2 rounded-xl bg-[#FAF9F6]">
                    <div className="font-bold text-[#141311]">{selectedNode.quiz_attempts}</div>
                    <div className="text-[10px] text-[#8A857C]">历史作答</div>
                  </div>
                  <div className="p-2 rounded-xl bg-[#FAF9F6]">
                    <div className="font-bold text-red-600">{selectedNode.active_mistakes}</div>
                    <div className="text-[10px] text-[#8A857C]">待克错题</div>
                  </div>
                </div>

                {selectedNode.notes.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-[#7A756C]">出处笔记</div>
                    {selectedNode.notes.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => onNavigate('notes', { noteId: n.id })}
                        className="w-full text-left flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F5F3EE] hover:bg-[#F3F5FC] text-xs font-medium text-[#1C1B18] cursor-pointer"
                      >
                        <BookOpen className="w-3.5 h-3.5 text-[#3B5BDB] shrink-0" />
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
                    className="flex items-center justify-center gap-1 py-2 rounded-xl bg-[#3B5BDB] text-white text-xs font-semibold cursor-pointer"
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
                    className="flex items-center justify-center gap-1 py-2 rounded-xl bg-[#EEF8F6] text-[#0F766E] text-xs font-semibold cursor-pointer"
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                    费曼讲透
                  </button>
                </div>
              </div>
            )}

            {/* Weak Concepts Ranking */}
            <div className="p-5 rounded-2xl bg-white border border-[#EAE6DF] space-y-2.5">
              <h3 className="font-bold text-sm text-[#141311]">薄弱知识点诊断排行</h3>
              <div className="space-y-1.5 max-h-60 overflow-y-auto">
                {weakConcepts.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => setSelectedNode(w)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition cursor-pointer ${
                      selectedNode?.id === w.id ? 'bg-[#F3F5FC] border border-[#3B5BDB]/40' : 'bg-[#FAF9F6] hover:bg-[#F1EFEA]'
                    }`}
                  >
                    <span className="font-medium text-[#1C1B18] truncate">{w.name}</span>
                    <span className="font-bold shrink-0" style={{ color: masteryColor(w.mastery_score) }}>
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
