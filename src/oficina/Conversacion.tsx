import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgenteOficina, Conversacion as Datos, ConversacionItem } from '../../shared/types';

type Props = {
  agente: AgenteOficina;
  /** Con esto se muestra la conversación de ese subagente, no la de la sesión. */
  agentId?: string;
  /** Nombres de los subagentes por `agentId`, para los mensajes entre ellos. */
  nombres: Map<string, string>;
  onAbrirSubagente: (agentId: string) => void;
};

const REFRESCO_MS = 2000;
const HORA = new Intl.DateTimeFormat('es', { timeStyle: 'medium' });

/**
 * La conversación de un agente mientras trabaja: lo que se dijo, cada
 * herramienta con su entrada y su resultado, los subagentes que lanzó y los
 * mensajes que se mandaron entre ellos. Se relee sola mientras está abierta.
 */
export default function Conversacion({ agente, agentId, nombres: conocidos, onAbrirSubagente }: Props) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState('');
  const cuerpo = useRef<HTMLDivElement>(null);
  const alFondo = useRef(true);

  useEffect(() => {
    let vigente = true;
    setDatos(null);
    alFondo.current = true;
    const leer = () =>
      window.claudeMonitor.conversacion(agente.sessionId, agentId).then((r) => {
        if (!vigente) return;
        if (r.ok) {
          setDatos(r.data);
          setError('');
        } else setError(r.error);
      });
    leer();
    const id = setInterval(leer, REFRESCO_MS);
    return () => {
      vigente = false;
      clearInterval(id);
    };
  }, [agente.sessionId, agentId]);

  // Sigue lo último sólo si ya estabas abajo: si subiste a leer, no te arrastra.
  useLayoutEffect(() => {
    const c = cuerpo.current;
    if (c && alFondo.current) c.scrollTop = c.scrollHeight;
  }, [datos]);

  /** Los mensajes entre agentes traen ids; se nombran con la tarea del subagente. */
  const nombres = useMemo(() => {
    const n = new Map<string, string>();
    for (const i of datos?.items ?? []) if (i.tipo === 'subagente' && i.agentId) n.set(i.agentId, i.descripcion || i.tipoAgente);
    for (const [k, v] of conocidos) n.set(k, v);
    return n;
  }, [datos, conocidos]);
  const nombre = (id: string) => nombres.get(id) ?? id;

  return (
    <div
      className="conv-cuerpo"
      ref={cuerpo}
      onScroll={(e) => {
        const c = e.currentTarget;
        alFondo.current = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
      }}
    >
      {error && <div className="error">{error}</div>}
      {!datos && !error && <p className="muted">Leyendo la conversación…</p>}
      {datos?.truncada && <p className="muted">Es tan larga que se cortó en {datos.items.length} pasos.</p>}
      {datos?.items.map((it, i) => <Paso key={i} it={it} nombre={nombre} onAbrir={onAbrirSubagente} />)}
    </div>
  );
}

function Hora({ ts }: { ts: string }) {
  return ts ? <span className="muted"> · {HORA.format(new Date(ts))}</span> : null;
}

function Paso({ it, nombre, onAbrir }: { it: ConversacionItem; nombre: (id: string) => string; onAbrir: (id: string) => void }) {
  switch (it.tipo) {
    case 'usuario':
    case 'claude':
      return (
        <article className={`conv-turno ${it.tipo}`}>
          <p className="conv-quien">
            {it.tipo === 'usuario' ? 'Vos' : 'Claude'}
            <Hora ts={it.ts} />
          </p>
          <p className="conv-texto">{it.texto}</p>
        </article>
      );
    case 'herramienta':
      return (
        <details className={`conv-tool${it.error ? ' error' : ''}${it.resultado === null ? ' corriendo' : ''}`}>
          <summary>
            <span className="conv-tool-nombre">{it.nombre}</span>
            {it.detalle && <span className="conv-tool-detalle"> {it.detalle}</span>}
            <span className="conv-tool-estado">{it.resultado === null ? 'corriendo…' : it.error ? 'error' : ''}</span>
          </summary>
          <pre>{it.entrada}</pre>
          {it.resultado !== null && <pre className="conv-resultado">{it.resultado || '(sin salida)'}</pre>}
        </details>
      );
    case 'subagente':
      return (
        <div className="conv-sub">
          <p>
            <strong>Subagente {it.tipoAgente}</strong>: {it.descripcion}
            <Hora ts={it.ts} />
          </p>
          <details>
            <summary>Lo que se le pidió</summary>
            <pre>{it.prompt}</pre>
          </details>
          {it.resultado && (
            <details>
              <summary>Lo que devolvió</summary>
              <pre>{it.resultado}</pre>
            </details>
          )}
          {it.agentId && (
            <button className="link" onClick={() => onAbrir(it.agentId)}>
              Ver su conversación →
            </button>
          )}
        </div>
      );
    case 'mensaje':
      return (
        <article className="conv-msg">
          <p className="conv-quien">
            {it.para ? `Mensaje para ${nombre(it.para)}` : `Mensaje de ${nombre(it.de)}`}
            <Hora ts={it.ts} />
          </p>
          <p className="conv-texto">{it.texto}</p>
        </article>
      );
    case 'aviso':
      return (
        <p className="muted conv-aviso">
          {it.texto}
          <Hora ts={it.ts} />
        </p>
      );
  }
}
