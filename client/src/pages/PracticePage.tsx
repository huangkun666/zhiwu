import { useEffect, useState } from 'react';
import { AlertTriangle, FileCheck2 } from 'lucide-react';
import { MistakesPage } from './MistakesPage';
import { QuizPage } from './QuizPage';
import type { Category, PageId } from '../types';

interface PracticePageProps {
  categories: Category[];
  activeMistakesCount: number;
  initialContext?: {
    subTab?: 'quiz' | 'mistakes';
    noteIds?: string[];
    weakOnly?: boolean;
    focusConcepts?: string[];
  } | null;
  onRefreshGlobal: () => void;
  onNavigate: (page: PageId, context?: any) => void;
}

export function PracticePage({
  categories,
  activeMistakesCount,
  initialContext,
  onRefreshGlobal,
  onNavigate,
}: PracticePageProps) {
  const [subTab, setSubTab] = useState<'quiz' | 'mistakes'>(initialContext?.subTab || 'quiz');

  useEffect(() => {
    if (initialContext?.subTab) {
      setSubTab(initialContext.subTab);
    } else if (initialContext?.noteIds || initialContext?.weakOnly) {
      setSubTab('quiz');
    }
  }, [initialContext]);

  return (
    <div className="space-y-6">
      <div
        className="inline-flex p-1 rounded-xl border"
        style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border-hairline)' }}
      >
        <button
          onClick={() => setSubTab('quiz')}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer"
          style={{
            background: subTab === 'quiz' ? 'var(--bg-card-solid)' : 'transparent',
            color: subTab === 'quiz' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <FileCheck2 className="w-3.5 h-3.5" />
          动态出题
        </button>
        <button
          onClick={() => setSubTab('mistakes')}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer"
          style={{
            background: subTab === 'mistakes' ? 'var(--bg-card-solid)' : 'transparent',
            color: subTab === 'mistakes' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          错题集
          {activeMistakesCount > 0 && (
            <span
              className="ml-0.5 px-1.5 py-0.2 rounded-md text-[10px] font-semibold tabular-nums"
              style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
            >
              {activeMistakesCount}
            </span>
          )}
        </button>
      </div>

      {subTab === 'quiz' ? (
        <QuizPage
          categories={categories}
          initialContext={initialContext}
          onRefreshGlobal={onRefreshGlobal}
          onNavigate={onNavigate}
        />
      ) : (
        <MistakesPage onRefreshGlobal={onRefreshGlobal} onNavigate={onNavigate} />
      )}
    </div>
  );
}
