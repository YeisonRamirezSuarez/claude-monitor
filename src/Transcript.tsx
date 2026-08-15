import { useEffect, useMemo, useState } from 'react';
import type { Transcript } from '../shared/types';

type Props = {
  /** Sesión a mostrar. Al cambiar, se recarga. */
  sessionId: string;
  /** La cuenta que va a poner los tokens si se reanuda desde acá. */
  activeProfileName: string;
  canResume: boolean;
  onResume: () => void;
  onClose: () => void;
};

const HORA = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short' });

/**
 * La conversación completa de una sesión, dentro de la app.
 *
 * Existe porque al reanudar en una terminal sólo queda lo que entra en el
 * scrollback: una conversación de mil mensajes se corta y lo de arriba no se
 * puede recuperar. Acá se lee del `.jsonl`, que lo tiene todo.
 */
export default function TranscriptView({ sessionId, activeProfileName, canResume, onResume, onClose }: Props) {
  const [data, setData] = useState<Transcript | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let vigente = true;
    setData(null);
    setError('');
    window.claudeMonitor
      .readTranscript(sessionId)
      .then((result) => {
        if (!vigente) return;
        if (result.ok) setData(result.data);
        else setError(result.error);
      })
      .catch((e) => vigente && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      vigente = false;
    };
  }, [sessionId]);

  // Escape cierra: es una capa que tapa todo, y buscar el botón para salir de
  // algo que ocupa la pantalla entera molesta.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return q ? data.messages.filter((m) => m.text.toLowerCase().includes(q)) : data.messages;
  }, [data, query]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="transcript" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <strong>Conversación completa</strong>
            {data && (
              <span className="muted">
                {' '}
                · {data.messages.length} mensajes
                {data.cwd && ` · ${data.cwd}`}
              </span>
            )}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en la conversación…"
          />
          <button
            className="primary"
            disabled={!canResume}
            title={
              canResume
                ? `Seguir esta conversación en la terminal, con la cuenta "${activeProfileName}"`
                : `La cuenta "${activeProfileName}" no tiene la sesión iniciada`
            }
            onClick={onResume}
          >
            Reanudar en la terminal
          </button>
          <button onClick={onClose}>Cerrar</button>
        </header>

        <div className="transcript-body">
          {error && <div className="error">{error}</div>}
          {!data && !error && <p className="muted">Leyendo la conversación…</p>}
          {data?.truncated && (
            <p className="muted">La conversación es tan larga que se cortó en {data.messages.length} mensajes.</p>
          )}
          {data && visible.length === 0 && <p className="muted">Ningún mensaje coincide con la búsqueda.</p>}

          {visible.map((m, i) => (
            <article key={i} className={`turno ${m.role}`}>
              <p className="turno-quien">
                {m.role === 'user' ? 'Vos' : 'Claude'}
                {m.timestamp && <span className="muted"> · {HORA.format(new Date(m.timestamp))}</span>}
              </p>
              {m.text && <p className="turno-texto">{m.text}</p>}
              {m.tools > 0 && (
                <p className="turno-tools">
                  {m.tools} {m.tools === 1 ? 'herramienta usada' : 'herramientas usadas'}
                </p>
              )}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
