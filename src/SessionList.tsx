import { useEffect, useMemo, useState } from 'react';
import type { SessionMeta, SessionTokens } from '../shared/types';
import { formatExact, formatSize, formatTokens, projectName, relativeDate } from './format';

const SIN_CONSUMO: SessionTokens = {
  input: 0,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  requests: 0,
  models: []
};

/** Todo lo que pasó por el modelo. Sirve para comparar sesiones entre sí, no
 *  para estimar plata: la caché leída pesa mucho y cuesta una fracción. */
const volumen = (t: SessionTokens): number => t.input + t.output + t.cacheCreate + t.cacheRead;

const DETALLE = (t: SessionTokens): string =>
  [
    `entrada: ${formatExact(t.input)}`,
    `salida: ${formatExact(t.output)}`,
    `caché escrita: ${formatExact(t.cacheCreate)}`,
    `caché leída: ${formatExact(t.cacheRead)}`,
    `respuestas: ${formatExact(t.requests)}`,
    t.models.length > 0 ? `modelos: ${t.models.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('\n');

const DIA = 86400000;

/**
 * El resumen de consumo de lo que se está viendo.
 *
 * Va sobre la lista y respeta el filtro: mirando un proyecto, los números son
 * los de ese proyecto. Un total fijo al lado de una lista filtrada invita a
 * leer el total como si fuera el de la lista.
 *
 * Los últimos 7 días salen del mtime del transcript —cuándo se escribió por
 * última vez— y no del timestamp de cada respuesta. Es una aproximación: una
 * sesión de hace un mes reanudada ayer cuenta entera como de ayer. Alcanza para
 * ver el ritmo; para partir el consumo por día habría que agrupar respuesta por
 * respuesta.
 */
function Metrics({
  sessions,
  tokens,
  cargando
}: {
  sessions: SessionMeta[];
  tokens: Record<string, SessionTokens>;
  cargando: boolean;
}) {
  const resumen = useMemo(() => {
    const total = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, requests: 0 };
    let semana = 0;
    const porProyecto = new Map<string, number>();
    const desde = Date.now() - 7 * DIA;

    for (const s of sessions) {
      const t = tokens[s.id];
      if (!t) continue;
      total.input += t.input;
      total.output += t.output;
      total.cacheCreate += t.cacheCreate;
      total.cacheRead += t.cacheRead;
      total.requests += t.requests;
      const v = volumen(t);
      if (s.mtime >= desde) semana += v;
      const nombre = projectName(s.cwd) || s.projectSlug;
      porProyecto.set(nombre, (porProyecto.get(nombre) ?? 0) + v);
    }

    const top = [...porProyecto.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { total, semana, top, volumen: total.input + total.output + total.cacheCreate + total.cacheRead };
  }, [sessions, tokens]);

  if (sessions.length === 0) return null;

  return (
    <section className="metrics">
      <div className="metrics-grid">
        <div title={DETALLE({ ...resumen.total, models: [] })}>
          <strong>{cargando ? '…' : formatTokens(resumen.volumen)}</strong>
          <span>tokens en total</span>
        </div>
        <div title={`Salida: lo que escribió el modelo. ${formatExact(resumen.total.output)} tokens.`}>
          <strong>{cargando ? '…' : formatTokens(resumen.total.output)}</strong>
          <span>de salida</span>
        </div>
        <div title="Suma de las sesiones tocadas en los últimos 7 días.">
          <strong>{cargando ? '…' : formatTokens(resumen.semana)}</strong>
          <span>últimos 7 días</span>
        </div>
        <div title={`${formatExact(resumen.total.requests)} respuestas del modelo.`}>
          <strong>{sessions.length}</strong>
          <span>{sessions.length === 1 ? 'sesión' : 'sesiones'}</span>
        </div>
      </div>
      {resumen.top.length > 0 && !cargando && (
        <p className="muted">
          Más consumo:{' '}
          {resumen.top.map(([nombre, v], i) => (
            <span key={nombre}>
              {i > 0 && ' · '}
              {nombre} <b>{formatTokens(v)}</b>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

type Props = {
  sessions: SessionMeta[];
  /** Consumo por id de sesión. Llega después que la lista: hay que leer los
   *  transcripts enteros. Vacío mientras tanto. */
  tokens: Record<string, SessionTokens>;
  tokensLoading: boolean;
  /** Qué decir cuando no hay ninguna sesión en ninguna cuenta. */
  emptyHint: string;
  /** La cuenta activa: la que va a poner los tokens al reanudar, sea o no la
   *  dueña de la sesión. */
  activeProfileName: string;
  canResume: boolean;
  onResume: (id: string) => void;
  /** Reanuda la misma conversación en Claude Desktop: adopta el transcript
   *  del CLI por su id, no abre una sesión nueva. */
  onResumeInDesktop: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
  onNewSession: () => void;
  onNewSessionInDesktop: () => void;
};

export default function SessionList({
  sessions,
  tokens,
  tokensLoading,
  emptyHint,
  activeProfileName,
  canResume,
  onResume,
  onResumeInDesktop,
  onDelete,
  onOpen,
  onNewSession,
  onNewSessionInDesktop
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
        {/* Los dos lugares donde se puede trabajar, uno al lado del otro: la
            terminal y Desktop. Antes había un solo botón y la elección no
            existía. */}
        <button className="primary" onClick={onNewSession}>
          Nueva en terminal…
        </button>
        <button onClick={onNewSessionInDesktop}>Nueva en Desktop…</button>
      </div>

      <Metrics sessions={filtered} tokens={tokens} cargando={tokensLoading} />

      {filtered.length === 0 && (
        <p className="muted">{sessions.length === 0 ? emptyHint : 'Ninguna sesión coincide con la búsqueda.'}</p>
      )}

      {filtered.map((s) => {
        const t = tokens[s.id] ?? SIN_CONSUMO;
        return (
        <article key={s.id} className="card">
          <p className="preview">{s.preview || <em className="muted">(sin mensajes)</em>}</p>
          <p className="meta">
            <span title={s.cwd}>{s.cwd}</span>
            {s.gitBranch && <span className="branch">{s.gitBranch}</span>}
            <span>{relativeDate(s.mtime)}</span>
            <span>{formatSize(s.sizeBytes)}</span>
            {/* Mientras no estén los números no se pone un 0: una sesión con
                consumo real leída como "0 tokens" es peor que no decir nada. */}
            {tokensLoading && !tokens[s.id] ? (
              <span className="muted">midiendo consumo…</span>
            ) : (
              t.requests > 0 && (
                <span className="tokens" title={DETALLE(t)}>
                  {formatTokens(volumen(t))} tok · {t.requests} resp
                </span>
              )
            )}
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
              Reanudar en terminal
            </button>
            {/* Sin `canResume`: eso mira el login del CLI, y el de Desktop es
                otro —vive en su propia carpeta de datos—. Una cuenta sin el CLI
                autorizado puede trabajar en Desktop igual. */}
            <button
              title={
                `Seguir esta misma conversación en el Claude Desktop de "${activeProfileName}". ` +
                'Desktop adopta el transcript y abre el historial entero.'
              }
              onClick={() => onResumeInDesktop(s.id)}
            >
              Reanudar en Desktop
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
        );
      })}
    </>
  );
}
