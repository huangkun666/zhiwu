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
    <div className="space-y-5">
      {/* Converged Top Switcher */}
      <div className="inline-flex p-1 rounded-xl bg-[#EFECE6]">
        <button
          onClick={() => setSubTab('quiz')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
            subTab === 'quiz' ? 'bg-white text-[#141311] shadow-sm' : 'text-[#6F6B63] hover:text-[#1C1B18]'
          }`}
        >
          <FileCheck2 className="w-3.5 h-3.5" />
          动态出题
        </button>
        <button
          onClick={() => setSubTab('mistakes')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
            subTab === 'mistakes' ? 'bg-white text-[#141311] shadow-sm' : 'text-[#6F6B63] hover:text-[#1C1B18]'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
          错题集与解析
          {activeMistakesCount > 0 && (
            <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">
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
