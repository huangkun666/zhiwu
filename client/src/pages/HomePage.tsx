import { useEffect, useState } from 'react';
import { LayoutDashboard, Network } from 'lucide-react';
import { DashboardPage } from './DashboardPage';
import { GraphPage } from './GraphPage';
import type { PageId } from '../types';

interface HomePageProps {
  initialSubTab?: 'overview' | 'graph';
  refreshTick: number;
  onNavigate: (page: PageId, context?: any) => void;
  onOpenImport: () => void;
  onRefreshGlobal: () => void;
}

export function HomePage({
  initialSubTab = 'overview',
  refreshTick,
  onNavigate,
  onOpenImport,
  onRefreshGlobal,
}: HomePageProps) {
  const [subTab, setSubTab] = useState<'overview' | 'graph'>(initialSubTab);

  useEffect(() => {
    setSubTab(initialSubTab);
  }, [initialSubTab]);

  return (
    <div className="space-y-5">
      {/* Converged Top Switcher */}
      <div className="inline-flex p-1 rounded-xl bg-[#EFECE6]">
        <button
          onClick={() => setSubTab('overview')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
            subTab === 'overview' ? 'bg-white text-[#141311] shadow-sm' : 'text-[#6F6B63] hover:text-[#1C1B18]'
          }`}
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          学习概览
        </button>
        <button
          onClick={() => setSubTab('graph')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
            subTab === 'graph' ? 'bg-white text-[#141311] shadow-sm' : 'text-[#6F6B63] hover:text-[#1C1B18]'
          }`}
        >
          <Network className="w-3.5 h-3.5" />
          知识图谱与诊断
        </button>
      </div>

      {subTab === 'overview' ? (
        <DashboardPage
          key={`dash-${refreshTick}`}
          onNavigate={onNavigate}
          onOpenImport={onOpenImport}
          onRefreshGlobal={onRefreshGlobal}
        />
      ) : (
        <GraphPage onNavigate={onNavigate} />
      )}
    </div>
  );
}
