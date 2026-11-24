import { useRef, useState } from 'react';
import { api } from '../api/client';
import type { TutorMessage, TutorSession } from '../types';
import type { TutorChatPayload } from '../../../server/src/shared/tutorHistory';

interface Turn {
  payload: TutorChatPayload;
  previous: TutorMessage[];
  question: TutorMessage;
  text: string;
  status: string;
  error?: string;
}

// A null key holds the first question while the session is being created.
export function useTutorTurns() {
  const [turns, setTurns] = useState(() => new Map<string | null, Turn>());
  const current = useRef(turns);

  const replace = (key: string | null, turn?: Turn) => {
    const next = new Map(current.current);
    if (turn) next.set(key, turn);
    else next.delete(key);
    current.current = next;
    setTurns(next);
  };

  const send = async (
    sessionId: string | null, draft: TutorChatPayload, previous: TutorMessage[],
    onCreated: (session: TutorSession) => void,
    onSaved: (id: string, messages: TutorMessage[]) => void,
  ) => {
    let key = sessionId;
    const existing = current.current.get(key);
    if (existing && !existing.error) return;
    const turnId = draft.turnId ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    const payload = { ...draft, turnId };
    const question: TutorMessage = {
      id: `pending-${turnId}`, session_id: key ?? '', role: 'user',
      content: payload.message, created_at: new Date().toISOString(),
    };
    // The offline API can update its message array in place before the stream finishes.
    const base = [...previous];
    const turn: Turn = { payload, previous: base, question, text: '', status: '' };
    replace(key, turn);
    const update = (patch: Partial<Pick<Turn, 'text' | 'status' | 'error'>>) => {
      const latest = current.current.get(key);
      if (latest?.question === question) replace(key, { ...latest, ...patch });
    };
    try {
      if (key === null) {
        const session = await api.createTutorSession({ mode: payload.mode, title: payload.message.slice(0, 22) });
        replace(null);
        key = session.id;
        replace(key, turn);
        onCreated(session);
      }
      let text = '';
      const reply = await api.sendTutorMessageStream(key, payload, delta => {
        text += delta;
        update({ text });
      }, status => update({ status }));
      if (current.current.get(key)?.question !== question) return;
      replace(key);
      onSaved(key, [...base, reply.userMessage, reply.assistantMessage]);
    } catch (cause) {
      update({ error: cause instanceof Error && cause.message ? cause.message : '暂时无法取得回复，请重试。' });
    }
  };

  return { turns, get: (id: string | null) => current.current.get(id), forget: (id: string) => replace(id), send };
}
