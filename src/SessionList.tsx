import { useEffect, useMemo, useState } from 'react';
import type { SessionMeta } from '../shared/types';

type Props = {
  sessions: SessionMeta[];
  canResume: boolean;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
};

const RELATIVE = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000000],
  ['month', 2592000000],
  ['day', 86400000],
  ['hour', 3600000],
  ['minute', 60000]
];

function relativeDate(mtime: number): string {
  const diff = mtime - Date.now();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return RELATIVE.format(Math.round(diff / ms), unit);
  }
  return 'hace un momento';
}

/** Las sesiones recién creadas pesan menos de 1 KB: redondearlas a "0 KB" se lee como un error. */
function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export default function SessionList({ sessions, canResume, onResume, onDelete }: Props) {
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
      <input
        className="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por texto o ruta…"
      />

      {filtered.length === 0 && <p className="muted">No hay sesiones.</p>}

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
              title={canResume ? '' : 'La cuenta activa no tiene sesión iniciada'}
              onClick={() => onResume(s.id)}
            >
              Reanudar
            </button>
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
