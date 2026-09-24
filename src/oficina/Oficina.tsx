import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgenteOficina, ProfileWithStatus } from '../../shared/types';
import Sala from './Sala';

type Props = {
  profiles: ProfileWithStatus[];
  /** En su propia ventana ocupa todo, sin el velo de capa encima del panel. */
  enVentana?: boolean;
  onClose: () => void;
};

/** Cada cuánto se relee el registro de sesiones vivas. Lee sólo la cola de
 *  los transcripts, así que es barato (~30 ms con varias cuentas). */
const REFRESCO_MS = 1500;
/** Cuánto queda a la vista un aviso de "llegó" / "se fue". */
const AVISO_MS = 6000;

export const ESTADO: Record<AgenteOficina['estado'] | 'terminado', string> = {
  escribiendo: 'trabajando',
  leyendo: 'leyendo',
  delegando: 'esperando a su subagente',
  pensando: 'pensando',
  permiso: '¡necesita permiso!',
  esperando: 'te espera',
  terminado: 'terminó ✓'
};

type Pixel = { id: number; sessionId: string; jsonlFile: string };

/** Cuánto tiene que estar muerta una sesión, según el registro, antes de
 *  cerrarla en la oficina. Cubre el hueco entre que Claude Code arranca y que
 *  anota la sesión en `sessions/<pid>.json`. */
const CIERRE_MS = 15_000;
/** Las de WSL no se miran acá (ver `agentesVivos`): no se puede afirmar que
 *  estén muertas. */
const esWsl = (ruta: string) => /wsl\.localhost|wsl\$/i.test(ruta);

/**
 * La Oficina en vivo: Pixel Agents con todas las sesiones de todas las
 * cuentas, parchado para que los agentes piensen en la biblioteca, esperen en
 * los sofás, se hablen caminando hasta el otro y entren y salgan por la puerta
 * (ver `vendor/pixel-agents`). Esta ventana le dice lo que él no sabe: qué
 * cuenta es cada sesión (el filtro) y a qué subagente le escribió cada una
 * (las charlas). Al costado, la lista por cuenta; clic en un personaje o en la
 * lista abre su sala: el equipo y la conversación de cada uno.
 */
export default function Oficina({ profiles, enVentana = false, onClose }: Props) {
  const [agentes, setAgentes] = useState<AgenteOficina[]>([]);
  const [error, setError] = useState('');
  const [cuenta, setCuenta] = useState<string>('todas');
  const [abierta, setAbierta] = useState<string | null>(null);
  /** El subagente enfocado dentro de la sesión abierta (su toolUseId), o null
   *  para el principal. La cámara de la oficina lo sigue. */
  const [foco, setFoco] = useState<string | null>(null);
  const [urlPixel, setUrlPixel] = useState('');
  const [errorPixel, setErrorPixel] = useState('');
  // Cambia al renombrar: recarga Pixel Agents para que tome el nombre nuevo.
  const [versionPixel, setVersionPixel] = useState(0);
  const [avisos, setAvisos] = useState<Array<{ id: number; texto: string }>>([]);
  /** La lista de la derecha se puede esconder para darle todo el ancho a la oficina. */
  const [conLista, setConLista] = useState(true);
  const [pixel, setPixel] = useState<Pixel[]>([]);
  const iframe = useRef<HTMLIFrameElement>(null);
  const anteriores = useRef<Map<string, string> | null>(null);
  const charlasVistas = useRef(new Set<string>());
  /** Personaje de Pixel Agents -> desde cuándo su sesión no está viva. */
  const muertas = useRef(new Map<number, number>());
  const leido = useRef(false);
  /** Las sesiones vivas de la última lectura, para el clic en un personaje. */
  const vivasRef = useRef(new Set<string>());

  useEffect(() => {
    window.claudeMonitor.oficinaPixel().then((r) => (r.ok ? setUrlPixel(r.data) : setErrorPixel(r.error)));
  }, []);

  const avisar = (texto: string) => {
    const id = Date.now() + Math.random();
    setAvisos((a) => [...a, { id, texto }]);
    setTimeout(() => setAvisos((a) => a.filter((x) => x.id !== id)), AVISO_MS);
  };

  const leer = () =>
    window.claudeMonitor.oficina().then((r) => {
      if (!r.ok) return setError(r.error);
      setError('');
      setAgentes(r.data);
      leido.current = true;
      vivasRef.current = new Set(r.data.map((a) => a.sessionId));
      // Llegadas y salidas, comparando con la lectura anterior. La primera no
      // cuenta: son las que ya estaban abiertas.
      const ahora = new Map(r.data.map((a) => [a.sessionId, `★ ${a.nombre} (${a.profileName})`]));
      if (anteriores.current) {
        for (const [id, nombre] of ahora) if (!anteriores.current.has(id)) avisar(`Llegó ${nombre}`);
        for (const [id, nombre] of anteriores.current) if (!ahora.has(id)) avisar(`Se fue ${nombre}`);
      }
      anteriores.current = ahora;
    });

  useEffect(() => {
    leer();
    const id = setInterval(() => {
      leer();
      window.claudeMonitor.mapaPixel().then((r) => r.ok && setPixel(r.data));
    }, REFRESCO_MS);
    return () => clearInterval(id);
  }, []);

  const origen = urlPixel ? new URL(urlPixel).origin : '';
  const alPixel = (msg: unknown) => iframe.current?.contentWindow?.postMessage(msg, origen);

  // El clic en un personaje llega por postMessage desde el iframe (parche en
  // `vendor/pixel-agents`) con su id numérico.
  useEffect(() => {
    if (!origen) return;
    const onMsg = async (e: MessageEvent) => {
      if (e.origin !== origen || e.data?.type !== 'claude-monitor:focus' || typeof e.data.agentId !== 'number') return;
      const mapa = await window.claudeMonitor.mapaPixel();
      const pj = mapa.ok ? mapa.data.find((p) => p.id === e.data.agentId) : undefined;
      if (!pj) return avisar('Pixel Agents no sabe todavía de qué sesión es ese personaje. Probá de nuevo en un segundo.');
      // Un personaje de una sesión que ya terminó: se lo saca de la oficina en
      // vez de abrir un panel vacío.
      if (!vivasRef.current.has(pj.sessionId) && !esWsl(pj.jsonlFile)) {
        alPixel({ type: 'claude-monitor:close', id: pj.id });
        return avisar('Esa sesión ya terminó: la saco de la oficina.');
      }
      setAbierta(pj.sessionId);
      setFoco(null);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origen]);

  // La lista coincide con la oficina: arriba las sesiones que están en ella; las
  // abiertas pero quietas desde hace rato (Pixel Agents sólo adopta una sesión
  // cuando vuelve a escribir) quedan plegadas al final.
  const [verQuietas, setVerQuietas] = useState(false);
  const enPixel = useMemo(() => new Set(pixel.map((p) => p.sessionId)), [pixel]);

  const visibles = useMemo(
    () => (cuenta === 'todas' ? agentes : agentes.filter((a) => a.profileId === cuenta)),
    [agentes, cuenta]
  );

  // El filtro por cuenta, adentro de la oficina: sólo se dibujan los
  // personajes de las sesiones de esa cuenta (y sus subagentes).
  useEffect(() => {
    if (!origen) return;
    const sesiones = new Set(visibles.map((a) => a.sessionId));
    alPixel({ type: 'claude-monitor:visible', ids: cuenta === 'todas' ? null : pixel.filter((p) => sesiones.has(p.sessionId)).map((p) => p.id) });
  }, [visibles, pixel, cuenta, origen, versionPixel]);

  // Las charlas: cuando una sesión le escribe a un subagente (o él a ella),
  // Pixel Agents hace caminar al que habla hasta el otro. Él no sabe a qué
  // subagente iba el mensaje; acá sí, por el `toolUseId` que lo lanzó.
  useEffect(() => {
    if (!origen) return;
    const vivas = new Set<string>();
    for (const a of agentes) {
      const p = pixel.find((x) => x.sessionId === a.sessionId);
      for (const m of a.mensajes) {
        const clave = `${a.sessionId}:${m.de}>${m.para}`;
        vivas.add(clave);
        if (charlasVistas.current.has(clave) || !p) continue;
        const sub = a.subagentes.find((s) => s.agentId === (m.de || m.para));
        if (!sub?.toolUseId) continue;
        charlasVistas.current.add(clave);
        alPixel({ type: 'claude-monitor:talk', agentId: p.id, parentToolId: sub.toolUseId, toSub: Boolean(m.para) });
      }
    }
    for (const k of charlasVistas.current) if (!vivas.has(k)) charlasVistas.current.delete(k);
  }, [agentes, pixel, origen]);

  // Sesiones cerradas: Pixel Agents sólo se entera por el hook SessionEnd, y en
  // las cuentas sin los hooks instalados el personaje se quedaba para siempre.
  // Acá se sabe con certeza (registro + inicio del proceso): si su sesión ya no
  // está viva, se le pide que la cierre y el agente sale por la puerta.
  useEffect(() => {
    if (!origen || !leido.current) return;
    const vivas = new Set(agentes.map((a) => a.sessionId));
    const ahora = Date.now();
    for (const p of pixel) {
      if (vivas.has(p.sessionId) || esWsl(p.jsonlFile)) {
        muertas.current.delete(p.id);
        continue;
      }
      const desde = muertas.current.get(p.id) ?? ahora;
      muertas.current.set(p.id, desde);
      if (ahora - desde >= CIERRE_MS) {
        alPixel({ type: 'claude-monitor:close', id: p.id });
        // Se repite cada CIERRE_MS mientras el personaje siga ahí: un pedido
        // que se perdió (la oficina recargando) no lo deja para siempre.
        muertas.current.set(p.id, ahora);
      }
    }
    for (const id of muertas.current.keys()) if (!pixel.some((p) => p.id === id)) muertas.current.delete(id);
  }, [agentes, pixel, origen]);

  // Qué hace cada subagente: Pixel Agents sólo lo sabe si vio su lanzamiento,
  // y uno que ya corría cuando se abrió la oficina saldría como "Subtask".
  useEffect(() => {
    if (!origen) return;
    const items = agentes.flatMap((a) => {
      const p = pixel.find((x) => x.sessionId === a.sessionId);
      return p
        ? a.subagentes
            .filter((s) => s.toolUseId)
            .map((s) => ({ agentId: p.id, parentToolId: s.toolUseId, label: s.nombrePropio || s.descripcion || s.tipoAgente }))
        : [];
    });
    if (items.length) alPixel({ type: 'claude-monitor:labels', items });
    // El estado real de cada uno (del transcript y del registro de sesiones
    // vivas): en las sesiones sin hooks la oficina pierde eventos y se queda
    // con lo último que dedujo.
    const estados = agentes.flatMap((a) => {
      const p = pixel.find((x) => x.sessionId === a.sessionId);
      if (!p) return [];
      return [
        { agentId: p.id, parentToolId: null, estado: a.estado },
        ...a.subagentes.filter((s) => s.toolUseId).map((s) => ({ agentId: p.id, parentToolId: s.toolUseId, estado: s.estado }))
      ];
    });
    if (estados.length) alPixel({ type: 'claude-monitor:estados', items: estados });
    // Qué subagentes siguen corriendo en cada sesión: el que ya terminó y la
    // oficina no se enteró (le faltó el evento de fin) se despide y sale.
    for (const a of agentes) {
      const p = pixel.find((x) => x.sessionId === a.sessionId);
      if (!p) continue;
      const alive = a.subagentes.filter((s) => s.estado !== 'terminado' && s.toolUseId).map((s) => s.toolUseId);
      alPixel({ type: 'claude-monitor:subs', agentId: p.id, alive });
    }
  }, [agentes, pixel, origen, versionPixel]);

  // El foco de la cámara sigue a lo que está abierto: la sesión (su principal)
  // o el subagente elegido. Cerrar la sala suelta el foco.
  useEffect(() => {
    if (!origen) return;
    const p = abierta ? pixel.find((x) => x.sessionId === abierta) : undefined;
    if (p) alPixel({ type: 'claude-monitor:focus', agentId: p.id, parentToolId: foco });
    else if (!abierta) alPixel({ type: 'claude-monitor:unfocus' });
  }, [abierta, foco, pixel, origen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !abierta && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, abierta]);

  // Las abiertas que la oficina no tiene entran solas, una vez cada una: si
  // Pixel Agents no las toma (Watch All Sessions apagado), quedan en la lista
  // plegada de abajo.
  const adoptadas = useRef(new Set<string>());
  useEffect(() => {
    if (!origen || pixel.length === 0) return;
    const faltan = agentes.filter((a) => a.transcript && !enPixel.has(a.sessionId) && !adoptadas.current.has(a.sessionId));
    if (faltan.length === 0) return;
    for (const a of faltan) adoptadas.current.add(a.sessionId);
    window.claudeMonitor.adoptarEnPixel(faltan.map((a) => ({ sessionId: a.sessionId, transcript: a.transcript, cwd: a.cwd })));
  }, [agentes, pixel, origen, enPixel]);

  const enOficina = visibles.filter((a) => enPixel.has(a.sessionId));
  const quietas = visibles.filter((a) => !enPixel.has(a.sessionId));

  const porCuenta = useMemo(() => {
    const n = new Map<string, number>();
    for (const a of agentes) if (enPixel.has(a.sessionId)) n.set(a.profileId, (n.get(a.profileId) ?? 0) + 1);
    return n;
  }, [agentes, enPixel]);

  const agenteAbierto = abierta ? agentes.find((a) => a.sessionId === abierta) : undefined;
  const necesitan = visibles.filter((a) => a.estado === 'permiso').length;

  return (
    <div className={enVentana ? 'oficina-ventana' : 'overlay oficina-overlay'}>
      <div className="oficina">
        <header>
          <strong>Oficina</strong>
          <span className="muted">
            {enOficina.length} en la oficina
            {necesitan > 0 && <span className="oficina-alerta"> · {necesitan} necesita(n) tu permiso</span>}
          </span>
          <nav className="oficina-cuentas">
            <button className={cuenta === 'todas' ? 'activa' : ''} onClick={() => setCuenta('todas')}>
              Todas <span>{enPixel.size}</span>
            </button>
            {profiles
              .filter((p) => p.entorno?.tipo !== 'wsl')
              .map((p) => (
                <button key={p.id} className={cuenta === p.id ? 'activa' : ''} onClick={() => setCuenta(p.id)}>
                  {p.name} <span>{porCuenta.get(p.id) ?? 0}</span>
                </button>
              ))}
          </nav>
          <button className="link" title={conLista ? 'Esconder la lista' : 'Mostrar la lista'} onClick={() => setConLista(!conLista)}>
            ☰
          </button>
          <button onClick={onClose}>Cerrar</button>
        </header>
        {error && <div className="error">{error}</div>}
        <div className="oficina-cuerpo">
          <div className="oficina-pixel">
            {errorPixel && <div className="error">{errorPixel}</div>}
            {!urlPixel && !errorPixel && <p className="muted">Abriendo la oficina…</p>}
            {urlPixel && <iframe ref={iframe} key={versionPixel} src={urlPixel} title="Pixel Agents" />}
            {agenteAbierto && (
              <div className="oficina-siguiendo">
                Siguiendo a{' '}
                {foco
                  ? `↳ ${agenteAbierto.subagentes.find((s) => s.toolUseId === foco)?.descripcion ?? 'subagente'}`
                  : `★ ${agenteAbierto.nombre}`}
                <button className="link" onClick={() => setAbierta(null)}>
                  soltar
                </button>
              </div>
            )}
            {avisos.length > 0 && (
              <div className="oficina-avisos">
                {avisos.map((a) => (
                  <p key={a.id}>{a.texto}</p>
                ))}
              </div>
            )}
          </div>
          {conLista && <ul className="oficina-lista">
            {enOficina.length === 0 && <li className="muted">Nadie trabajando en esta cuenta.</li>}
            {[...enOficina, ...(verQuietas ? quietas : [])].map((a) => (
              <li key={a.sessionId} className={enPixel.has(a.sessionId) ? '' : 'quieta'}>
                <button
                  className={`oficina-item ${a.estado}${abierta === a.sessionId ? ' activo' : ''}`}
                  onClick={() => {
                    setAbierta(a.sessionId);
                    setFoco(null);
                  }}
                >
                  <strong>★ {a.nombre}</strong>
                  {a.nota && <em>{a.nota}</em>}
                  <span>
                    {ESTADO[a.estado]}
                    {a.herramienta && ` · ${a.herramienta}`}
                    {cuenta === 'todas' && ` · ${a.profileName}`}
                  </span>
                </button>
                {a.subagentes.length > 0 && (
                  <ul>
                    {a.subagentes.map((s) => (
                      <li key={s.agentId}>
                        <button
                          className={`oficina-item sub ${s.estado}${abierta === a.sessionId && foco === s.toolUseId ? ' activo' : ''}`}
                          onClick={() => {
                            setAbierta(a.sessionId);
                            setFoco(s.toolUseId || null);
                          }}
                        >
                          <strong>↳ {s.nombrePropio || s.descripcion || s.tipoAgente}</strong>
                          <span>
                            {ESTADO[s.estado]}
                            {s.herramienta && ` · ${s.herramienta}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {quietas.length > 0 && (
              <li>
                <button className="link oficina-quietas" onClick={() => setVerQuietas(!verQuietas)}>
                  {verQuietas ? '▾' : '▸'} {quietas.length}{' '}
                  {quietas.length === 1 ? 'abierta sin actividad reciente' : 'abiertas sin actividad reciente'}
                </button>
              </li>
            )}
          </ul>}
        </div>
      </div>
      {abierta && agenteAbierto && (
        <Sala
          agente={agenteAbierto}
          foco={foco}
          onEnfocar={setFoco}
          onRenombrado={() => {
            leer();
            setVersionPixel((v) => v + 1);
          }}
          onClose={() => {
            setAbierta(null);
            setFoco(null);
          }}
        />
      )}
      {abierta && !agenteAbierto && (
        <aside className="conv">
          <header>
            <div>
              <strong>Esta sesión ya no está abierta</strong>
            </div>
            <button onClick={() => setAbierta(null)}>Cerrar</button>
          </header>
        </aside>
      )}
    </div>
  );
}
