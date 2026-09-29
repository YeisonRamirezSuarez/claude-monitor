import { useEffect, useRef, useState } from 'react';
import type { EstadoTelegram, Result } from '../shared/types';

/**
 * La sección de Telegram. La app se reparte al equipo, así que cada uno la arma
 * solo: su bot, su grupo y su chat (spec §9). Viene apagada.
 */
export default function TelegramPanel({ onClose }: { onClose: () => void }) {
  const [e, setE] = useState<EstadoTelegram | null>(null);
  const [token, setToken] = useState('');
  const [aviso, setAviso] = useState('');

  const [umbral, setUmbral] = useState('');
  const [reabriendo, setReabriendo] = useState<string[]>([]);
  const umbralEnfocado = useRef(false);
  const cargado = useRef(false);
  const avisoDeSondeo = useRef(false);

  // Devuelve si salió bien, para que quien llama decida qué limpiar. El sondeo
  // (`sondeo`) sólo actualiza el estado: si borrara el aviso, el error de una
  // acción del usuario desaparecería a los 3 s sin que lo alcance a leer.
  const usar = async (p: Promise<Result<EstadoTelegram>>, sondeo = false) => {
    const r = await p;
    if (r.ok) {
      setE(r.data);
      cargado.current = true;
      // Un error del sondeo se va con la primera carga buena; el de una acción no.
      if (!sondeo || avisoDeSondeo.current) setAviso('');
      avisoDeSondeo.current = false;
    } else if (!sondeo) {
      setAviso(r.error);
      avisoDeSondeo.current = false;
    } else if (!cargado.current) {
      // El intervalo cierra sobre el primer render (e siempre null): por eso se usa un ref.
      setAviso(r.error);
      avisoDeSondeo.current = true;
    }
    return r.ok;
  };

  useEffect(() => {
    usar(window.claudeMonitor.telegramEstado(), true);
    const id = setInterval(() => usar(window.claudeMonitor.telegramEstado(), true), 3000);
    return () => clearInterval(id);
  }, []);

  // Sin pisar lo que el usuario está tipeando.
  useEffect(() => {
    if (e && !umbralEnfocado.current) setUmbral(String(e.umbralMin));
  }, [e?.umbralMin]);

  if (!e)
    return (
      <div className="logs-overlay" onClick={onClose}>
        <div className="logs-panel telegram-panel" onClick={(ev) => ev.stopPropagation()}>
          <div className="logs-header">
            <h2>Telegram</h2>
            <button className="link" onClick={onClose}>Cerrar</button>
          </div>
          {aviso ? <p className="error" role="alert">{aviso}</p> : <p className="muted">Cargando…</p>}
        </div>
      </div>
    );

  const confirmarUmbral = async () => {
    umbralEnfocado.current = false;
    const n = Number(umbral);
    if (umbral.trim() === '' || !Number.isFinite(n) || n === e.umbralMin) return setUmbral(String(e.umbralMin));
    const res = await window.claudeMonitor.telegramUmbral(n);
    if (res.ok) {
      setE(res.data);
      setAviso('');
      avisoDeSondeo.current = false;
      setUmbral(String(res.data.umbralMin));
    } else {
      setAviso(res.error);
      avisoDeSondeo.current = false;
      setUmbral(String(e.umbralMin));
    }
  };

  const reabrir = async (id: string) => {
    setReabriendo((x) => [...x, id]);
    const r = await window.claudeMonitor.telegramReabrir(id);
    if (r.ok) await usar(window.claudeMonitor.telegramEstado());
    else setAviso(r.error);
    setReabriendo((x) => x.filter((y) => y !== id));
  };

  // Cambiar de bot desvincula el chat, así que se avisa antes de guardar.
  const guardarToken = async () => {
    if (e.vinculado && e.bot && !window.confirm('Cambiar de bot desvincula el chat y apaga el puente. ¿Seguir?')) return;
    if (await usar(window.claudeMonitor.telegramToken(token))) setToken('');
  };
  const MOTIVO = { manual: 'a mano', tapa: 'tapa cerrada', inactividad: 'sin actividad' } as const;

  // El backend desvincula el chat actual apenas se pide otro código: hay que avisar antes.
  const vincular = () => {
    if (e.vinculado && !window.confirm('Se desvincula el chat actual hasta que mandes el código nuevo. ¿Seguir?')) return;
    usar(window.claudeMonitor.telegramVincular());
  };

  return (
    <div className="logs-overlay" onClick={onClose}>
      <div className="logs-panel telegram-panel" onClick={(ev) => ev.stopPropagation()}>
        <div className="logs-header">
          <h2>Telegram</h2>
          <button className="link" onClick={onClose}>Cerrar</button>
        </div>

        <ol className="muted">
          <li>Creá un bot con @BotFather y copiá el token.</li>
          <li>Creá un grupo, activá <b>Temas</b> y agregá el bot como administrador con "Gestionar temas".</li>
          <li>Pegá el token acá, tocá Vincular y mandale el código al bot en el grupo.</li>
        </ol>
        <p className="muted">
          Lo que pide permiso y el último mensaje de cada turno pasan por los servidores de Telegram.
        </p>

        {e.error && <p className="error" role="alert">{e.error}</p>}
        {aviso && aviso !== e.error && <p className="error" role="alert">{aviso}</p>}

        <label>
          Token del bot {e.bot && <span className="muted">(@{e.bot})</span>}
          <input type="password" value={token} onChange={(ev) => setToken(ev.target.value)} placeholder="123456:ABC…" />
        </label>
        {e.vinculado && !e.bot && (
          <p className="muted">Volvé a pegar el token del bot (no se pudo leer el guardado).</p>
        )}
        <button
          onClick={guardarToken}
          disabled={!token.trim()}
        >
          Probar y guardar
        </button>

        <div>
          <button onClick={vincular} disabled={!e.bot}>
            {e.vinculado ? 'Vincular otro chat' : 'Vincular'}
          </button>
          {e.codigo && (
            <span>
              {' '}Mandá <code>/vincular {e.codigo}</code> en el grupo (vence en 10 min).
            </span>
          )}
          {e.vinculado && !e.codigo && <span className="muted"> Chat vinculado.</span>}
        </div>

        <label>
          Modo fuera tras
          <input
            type="number"
            min={1}
            max={240}
            value={umbral}
            onFocus={() => (umbralEnfocado.current = true)}
            onChange={(ev) => setUmbral(ev.target.value)}
            onBlur={confirmarUmbral}
            onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()}
          />
          minutos sin tocar teclado ni mouse
        </label>

        <label className="telegram-switch">
          <input
            type="checkbox"
            checked={e.activo}
            disabled={!e.vinculado && !e.activo}
            onChange={(ev) => usar(window.claudeMonitor.telegramActivar(ev.target.checked))}
          />
          Activo
        </label>

        <div>
          Estado: <b>{e.fuera ? `fuera (${e.motivo ? MOTIVO[e.motivo] : ''})` : 'en la PC'}</b>{' '}
          <button className="link" onClick={() => usar(window.claudeMonitor.telegramFuera(!e.fuera))}>
            {e.fuera ? 'Volví' : 'Me voy'}
          </button>
          {e.motivo === 'manual' && (
            <button
              className="link"
              title="Vuelve a decidir solo: tapa cerrada o inactividad"
              onClick={() => usar(window.claudeMonitor.telegramFuera(null))}
            >
              Automático
            </button>
          )}
        </div>

        {e.tomadas.length > 0 && (
          <div>
            <h3>Continuadas desde Telegram</h3>
            <ul>
              {e.tomadas.map((id) => (
                <li key={id}>
                  <code>{id.slice(0, 8)}</code>{' '}
                  <button className="link" disabled={reabriendo.includes(id)} onClick={() => reabrir(id)}>
                    Reabrir en terminal
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
