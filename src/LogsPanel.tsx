import { useEffect, useState } from 'react';
import type { Logs } from '../shared/types';

/**
 * Lo que la app hizo, visible sin salir de la app.
 *
 * Existe porque casi todo lo que puede fallar acá pasa AFUERA del panel: qué
 * ejecutable se lanzó, a qué cuenta se le mandó un enlace, qué dijo Desktop.
 * Pedirle al usuario que abra un `.log` en AppData para poder ayudarlo es
 * pedirle que haga de programador. Este panel muestra las mismas líneas, dos
 * fuentes una al lado de la otra: lo que hizo el panel, y lo que registró la
 * ventana de Desktop de la cuenta elegida — comparar las horas de las dos es
 * la mitad del diagnóstico.
 */

function Columna({ titulo, lineas }: { titulo: string; lineas: string[] }) {
  return (
    <div className="logs-col">
      <h3>{titulo}</h3>
      {lineas.length === 0 ? (
        <p className="muted">Nada todavía.</p>
      ) : (
        <pre>{lineas.join('\n')}</pre>
      )}
    </div>
  );
}

export default function LogsPanel({
  profileId,
  profileName,
  onClose
}: {
  /** De qué cuenta mirar el log de Desktop. Sin cuenta sólo se ve el del panel. */
  profileId: string | null;
  profileName: string;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<Logs | null>(null);

  useEffect(() => {
    let vivo = true;
    const cargar = () =>
      window.claudeMonitor.readLogs(profileId ?? undefined).then((r) => {
        if (vivo && r.ok) setLogs(r.data);
      });
    cargar();
    // Cada 3s: esto se abre JUSTO cuando algo está fallando, y quedarse
    // mirando una foto vieja mientras el problema sigue en curso no sirve.
    const id = setInterval(cargar, 3000);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [profileId]);

  return (
    <div className="logs-overlay" onClick={onClose}>
      <div className="logs-panel" onClick={(e) => e.stopPropagation()}>
        <div className="logs-header">
          <h2>Registro</h2>
          {logs && <span className="muted" title="También queda guardado acá, para mandarlo si hace falta">{logs.archivo}</span>}
          <button className="link" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div className="logs-grid">
          <Columna titulo="Esta app" lineas={logs?.panel ?? []} />
          <Columna
            titulo={profileId ? `Desktop de "${profileName}"` : 'Desktop (elegí una cuenta)'}
            lineas={logs?.desktop ?? []}
          />
        </div>
      </div>
    </div>
  );
}
