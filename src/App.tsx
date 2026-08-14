import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import SessionList from './SessionList';
import type { ProfileList, Result, SessionMeta } from '../shared/types';

/** Desempaqueta un Result: devuelve los datos, o setea el error y devuelve null. */
function unwrap<T>(result: Result<T>, setError: (e: string) => void): T | null {
  if (result.ok) return result.data;
  setError(result.error);
  return null;
}

export default function App() {
  const [profileList, setProfileList] = useState<ProfileList | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Dos refresh pueden estar en vuelo a la vez (una acción y el listener de
  // focus, o dos clics rápidos). Sólo el último iniciado puede escribir estado:
  // sin esto, el que resuelve último gana y la UI queda mostrando otra cuenta.
  const runId = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++runId.current;
    setLoading(true);
    // `handle` en el main process nunca deja escapar una excepción, pero el
    // canal sí puede rechazar (proceso principal caído, canal no registrado).
    // Sin este catch el refresh aborta antes de bajar `loading` y la ventana
    // queda en "Cargando…" para siempre, sin decir nada.
    try {
      const profiles = unwrap(await window.claudeMonitor.listProfiles(), setError);
      if (mine !== runId.current) return;
      if (profiles) setProfileList(profiles);
      const list = unwrap(await window.claudeMonitor.listSessions(), setError);
      if (mine !== runId.current) return;
      setSessions(list ?? []);
    } catch (e) {
      if (mine !== runId.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    // El login ocurre en una terminal externa: al volver el foco, re-verificar.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const activeProfile = profileList?.profiles.find((p) => p.id === profileList.activeProfileId);

  const run = async (action: () => Promise<Result<unknown>>) => {
    setError('');
    try {
      const result = await action();
      if (!result.ok) setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };

  return (
    <div className="layout">
      <Sidebar
        profileList={profileList}
        sessions={sessions}
        selectedSlug={selectedSlug}
        onSelectSlug={setSelectedSlug}
        onSelectProfile={(id) => {
          setSelectedSlug(null);
          run(() => window.claudeMonitor.setActiveProfile(id));
        }}
        onAddAccount={async (name) => {
          setError('');
          const created = await window.claudeMonitor.createProfile(name);
          if (!created.ok) return setError(created.error);
          await run(() => window.claudeMonitor.loginProfile(created.data.id));
        }}
        onLogin={(id) => run(() => window.claudeMonitor.loginProfile(id))}
        onDeleteProfile={(id) => {
          setSelectedSlug(null);
          run(() => window.claudeMonitor.deleteProfile(id));
        }}
      />
      <main className="main">
        {error && <div className="error">{error}</div>}
        {loading ? (
          <p className="muted">Cargando…</p>
        ) : (
          <SessionList
            sessions={selectedSlug ? sessions.filter((s) => s.projectSlug === selectedSlug) : sessions}
            canResume={Boolean(activeProfile?.authenticated)}
            onResume={(id) => run(() => window.claudeMonitor.resumeSession(id))}
            onDelete={(id) => run(() => window.claudeMonitor.deleteSession(id))}
          />
        )}
      </main>
    </div>
  );
}
