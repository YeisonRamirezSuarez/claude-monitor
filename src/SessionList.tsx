import { useEffect, useMemo, useState } from 'react';
import type { SessionMeta } from '../shared/types';
import { formatSize, relativeDate } from './format';

type Props = {
  sessions: SessionMeta[];
  /** Qué decir cuando no hay ninguna sesión en ninguna cuenta. */
  emptyHint: string;
  /** La cuenta activa: la que va a poner los tokens al reanudar, sea o no la
   *  dueña de la sesión. */
  activeProfileName: string;
  canResume: boolean;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
  onNewSession: () => void;
};

export default function SessionList({
  sessions,
  emptyHint,
  activeProfileName,
  canResume,
  onResume,
  onDelete,
  onOpen,
  onNewSession
}: Props) {
  const [query, setQuery] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.preview.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }, [sessions, query]);

  // Si la sesión con confirmación abierta desaparece de la lista (búsqueda,
  // cambio de proyecto, refresco), se cierra. Sin esto el flag sobrevive
  // oculto y vuelve a armar el botón de borrado al reaparecer la sesión.
  useEffect(() => {
    if (confirmId && !filtered.some((s) => s.id === confirmId)) setConfirmId(null);
  }, [filtered, confirmId]);

  return (
    <>
      <div className="toolbar">
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por texto o ruta…"
        />
        <button className="primary" onClick={onNewSession}>
          Nueva sesión…
        </button>
      </div>

      {filtered.length === 0 && (
        <p className="muted">{sessions.length === 0 ? emptyHint : 'Ninguna sesión coincide con la búsqueda.'}</p>
      )}

      {filtered.map((s) => (
        <article key={s.id} className="card">
          <p className="preview">{s.preview || <em className="muted">(sin mensajes)</em>}</p>
          <p className="meta">
            <span title={s.cwd}>{s.cwd}</span>
            {s.gitBranch && <span className="branch">{s.gitBranch}</span>}
            <span>{relativeDate(s.mtime)}</span>
            <span>{formatSize(s.sizeBytes)}</span>
          </p>
          <div className="actions">
            <button
              disabled={!canResume}
              title={
                canResume
                  ? `Reanudar con la cuenta "${activeProfileName}"`
                  : `La cuenta "${activeProfileName}" no tiene la sesión iniciada`
              }
              onClick={() => onResume(s.id)}
            >
              Reanudar
            </button>
            <button onClick={() => onOpen(s.id)}>Ver conversación</button>
            <button className="danger" onClick={() => setConfirmId(s.id)}>
              Borrar
            </button>
          </div>
          {confirmId === s.id && (
            <div className="confirm">
              <p>¿Borrar esta sesión? La acción es irreversible.</p>
              <button
                className="danger"
                onClick={() => {
                  onDelete(s.id);
                  setConfirmId(null);
                }}
              >
                Borrar
              </button>
              <button onClick={() => setConfirmId(null)}>Cancelar</button>
            </div>
          )}
        </article>
      ))}
    </>
  );
}
