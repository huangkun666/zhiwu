import { useEffect, useState } from 'react';
import { LayoutDashboard, Network } from 'lucide-react';
import { DashboardPage } from './DashboardPage';
import { GraphPage } from './GraphPage';
import type { MasteryChange } from '../../../server/src/shared/todayLearning';
import type { PageId } from '../types';

interface HomePageProps {
  initialSubTab?: 'overview' | 'graph';
  refreshTick: number;
  masteryChanges?: MasteryChange[];
  onNavigate: (page: PageId, context?: any) => void;
  onOpenImport: () => void;
  onRefreshGlobal: () => void;
}

export function HomePage({
  initialSubTab = 'overview',
  refreshTick,
  masteryChanges,
  onNavigate,
  onOpenImport,
  onRefreshGlobal,
}: HomePageProps) {
  const [subTab, setSubTab] = useState<'overview' | 'graph'>(initialSubTab);

  useEffect(() => {
    setSubTab(initialSubTab);
  }, [initialSubTab]);

  return (
    <div className="space-y-6">
      <div
        className="inline-flex p-1 rounded-xl border"
        style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
      >
        <button
          onClick={() => setSubTab('overview')}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer"
          style={{
            background: subTab === 'overview' ? 'var(--bg-card-solid)' : 'transparent',
            color: subTab === 'overview' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          学习概览
        </button>
        <button
          onClick={() => setSubTab('graph')}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer"
          style={{
            background: subTab === 'graph' ? 'var(--bg-card-solid)' : 'transparent',
            color: subTab === 'graph' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <Network className="w-3.5 h-3.5" />
          知识图谱
        </button>
      </div>

      {subTab === 'overview' ? (
        <DashboardPage
          key={`dash-${refreshTick}`}
          masteryChanges={masteryChanges}
          onNavigate={onNavigate}
          onOpenImport={onOpenImport}
          onRefreshGlobal={onRefreshGlobal}
        />
      ) : (
        <GraphPage key={`graph-${refreshTick}`} onNavigate={onNavigate} />
      )}
    </div>
  );
}
