import { useEffect, useMemo, useState } from 'react';
import type { AgenteOficina, SubagenteOficina } from '../../shared/types';
import Conversacion from './Conversacion';
import { ESTADO } from './Oficina';

type Props = {
  agente: AgenteOficina;
  /** Se guardó un nombre: hay que releer la oficina y recargar Pixel Agents. */
  onRenombrado: () => void;
  /** El subagente que la cámara sigue (su toolUseId), o null para el principal. */
  foco: string | null;
  onEnfocar: (toolUseId: string | null) => void;
  onClose: () => void;
};

const REFRESCO_MS = 2000;

/**
 * La sala de una sesión: el equipo —el principal y cada subagente, qué hace
 * cada uno, qué corre y qué terminó— y la conversación del que esté elegido.
 * Dónde está cada uno y qué hace se ve en la oficina de Pixel Agents.
 */
export default function Sala({ agente, onRenombrado, foco, onEnfocar, onClose }: Props) {
  const [equipo, setEquipo] = useState<SubagenteOficina[]>([]);
  const [elegido, setElegido] = useState('');
  const [editando, setEditando] = useState(false);
  // Elegir a alguien del equipo enfoca la cámara de la oficina en él, y
  // enfocarlo desde la lista lo elige acá.
  const elegir = (agentId: string) => {
    setElegido(agentId);
    setEditando(false);
    onEnfocar(agentId ? (equipo.find((s) => s.agentId === agentId)?.toolUseId || null) : null);
  };
  useEffect(() => {
    const porFoco = foco ? equipo.find((s) => s.toolUseId === foco)?.agentId : '';
    if (porFoco !== undefined && porFoco !== elegido) setElegido(porFoco);
  }, [foco, equipo]);

  const leerEquipo = () =>
    window.claudeMonitor.equipo(agente.sessionId).then((r) => r.ok && setEquipo(r.data));

  useEffect(() => {
    setElegido('');
    setEditando(false);
    leerEquipo();
    const id = setInterval(leerEquipo, REFRESCO_MS);
    return () => clearInterval(id);
  }, [agente.sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nombres = useMemo(
    () => new Map(equipo.map((s) => [s.agentId, s.nombrePropio || s.descripcion || s.tipoAgente])),
    [equipo]
  );
  const sub = elegido ? equipo.find((s) => s.agentId === elegido) : undefined;
  const corriendo = equipo.filter((s) => s.estado !== 'terminado');
  const terminados = equipo.length - corriendo.length;

  const clave = elegido ? `${agente.sessionId}/${elegido}` : agente.sessionId;
  const nombreActual = elegido ? (sub?.nombrePropio ?? '') : agente.nombrePropio;
  const notaActual = elegido ? (sub?.nota ?? '') : agente.nota;

  return (
    <aside className="sala" onClick={(e) => e.stopPropagation()}>
      <header>
        <div>
          <strong>★ {agente.nombre}</strong>
          <p className="muted">
            {agente.profileName} · {ESTADO[agente.estado]} · {agente.cwd}
          </p>
          {agente.nota && <p className="sala-nota">{agente.nota}</p>}
        </div>
        <button onClick={onClose}>Cerrar</button>
      </header>

      {equipo.length > 0 && <div className="sala-equipo">
        <p className="muted">
          {`${corriendo.length} ${corriendo.length === 1 ? 'subagente corriendo' : 'subagentes corriendo'} · ${terminados} ${terminados === 1 ? 'terminó' : 'terminaron'}`}
        </p>
        <div className="sala-chips">
          <button className={`sala-chip principal ${agente.estado}${elegido === '' ? ' activo' : ''}`} onClick={() => elegir('')}>
            <strong>★ {agente.nombre}</strong>
            <span>principal · {ESTADO[agente.estado]}</span>
          </button>
          {equipo.map((s) => (
            <button
              key={s.agentId}
              className={`sala-chip ${s.estado}${elegido === s.agentId ? ' activo' : ''}`}
              onClick={() => elegir(s.agentId)}
              title={s.nota || s.descripcion}
            >
              <strong>{s.nombrePropio || s.descripcion || s.tipoAgente}</strong>
              <span>
                {s.tipoAgente} · {ESTADO[s.estado]}
                {s.herramienta && ` · ${s.herramienta}${s.detalle ? ` ${s.detalle}` : ''}`}
              </span>
            </button>
          ))}
        </div>
      </div>}

      <div className="sala-miembro">
        <div className="sala-miembro-cabeza">
          <div>
            <strong>
              {elegido ? (sub?.nombrePropio || sub?.descripcion || nombres.get(elegido) || elegido) : `★ ${agente.nombre}`}
            </strong>
            <p className="muted">
              {elegido
                ? `Subagente de ★ ${agente.nombre}${sub ? ` · ${sub.tipoAgente} · ${ESTADO[sub.estado]}` : ''}`
                : 'Agente principal de la sesión'}
            </p>
            {elegido && sub?.descripcion && <p className="sala-nota">Tarea: {sub.descripcion}</p>}
            {notaActual && <p className="sala-nota">{notaActual}</p>}
          </div>
          {!editando && (
            <button className="link" onClick={() => setEditando(true)}>
              Ponerle nombre
            </button>
          )}
        </div>
        {editando && (
          <Editor
            nombre={nombreActual}
            nota={notaActual}
            onCancelar={() => setEditando(false)}
            onGuardar={async (nombre, nota) => {
              await window.claudeMonitor.nombrar(clave, nombre, nota);
              setEditando(false);
              leerEquipo();
              onRenombrado();
            }}
          />
        )}
        <Conversacion
          agente={agente}
          agentId={elegido || undefined}
          nombres={nombres}
          onAbrirSubagente={(id) => elegir(id)}
        />
      </div>
    </aside>
  );
}

function Editor({
  nombre,
  nota,
  onGuardar,
  onCancelar
}: {
  nombre: string;
  nota: string;
  onGuardar: (nombre: string, nota: string) => void;
  onCancelar: () => void;
}) {
  const [n, setN] = useState(nombre);
  const [t, setT] = useState(nota);
  return (
    <form
      className="sala-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onGuardar(n, t);
      }}
    >
      <input autoFocus value={n} onChange={(e) => setN(e.target.value)} placeholder="Nombre (ej. Revisor de backend)" maxLength={200} />
      <textarea value={t} onChange={(e) => setT(e.target.value)} placeholder="¿Qué hace? (opcional)" rows={2} maxLength={1000} />
      <div>
        <button className="primary" type="submit">
          Guardar
        </button>
        <button type="button" onClick={onCancelar}>
          Cancelar
        </button>
        <span className="muted"> Vacío vuelve al nombre de siempre.</span>
      </div>
    </form>
  );
}
