import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import TranscriptView from './Transcript';
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
  const [notice, setNotice] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // El login en curso: el CLI ya abrió la autorización y espera el código.
  const [pendingLogin, setPendingLogin] = useState<{ id: string; needsExtension: boolean } | null>(null);
  const [loginCode, setLoginCode] = useState('');

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

  // Las sesiones son un pozo compartido entre todas las cuentas, así que vacío
  // significa que no hay ninguna en ningún lado.
  const emptyHint =
    'Todavía no hay sesiones. Creá la primera con "Nueva sesión…": se abre con la cuenta marcada arriba.';

  // Reanudar es el mismo camino desde la tarjeta y desde el visor: abre la
  // terminal con la cuenta activa y avisa si la sesión viene compactada.
  const resume = async (id: string) => {
    setError('');
    setNotice('');
    const result = await window.claudeMonitor.resumeSession(id);
    if (!result.ok) return setError(result.error);
    if (result.data.compactions > 0) {
      setNotice(
        `Esta sesión fue compactada ${result.data.compactions} ${result.data.compactions === 1 ? 'vez' : 'veces'}. ` +
          'Claude Code reanuda desde el último resumen, así que en la terminal no vas a ver los mensajes anteriores a esa compactación: están resumidos, no perdidos.'
      );
    }
  };

  // Abre el Chrome de una cuenta, siempre en claude.ai. Hay dos pasos que la
  // app no puede hacer por el usuario —iniciar sesión con esa cuenta e instalar
  // la extensión en ese perfil— y se explican cuando el perfil es nuevo. El
  // aviso no puede ser la única señal: que el perfil ya exista no significa que
  // esté logueado, así que la página abre igual y ahí se ve.
  const openChrome = async (id: string) => {
    setError('');
    setNotice('');
    const result = await window.claudeMonitor.openChrome(id);
    if (!result.ok) return setError(result.error);
    setNotice(
      result.data.needsExtension
        ? 'Se abrió el Chrome de esta cuenta en la tienda: instalá ahí la extensión de Claude. Las extensiones son por ' +
            'perfil, así que va una vez por cada cuenta — sin ella, la sesión dice "browser extension is not connected".'
        : 'Chrome se abrió con el perfil de esta cuenta, en claude.ai. Fijate qué cuenta aparece logueada: ' +
            'la extensión sólo conecta si es la misma con la que abrís la sesión.'
    );
  };

  // El login de una cuenta, conducido desde acá.
  //
  // La autorización se abre en el Chrome de ESA cuenta, no en el navegador por
  // defecto: así el mismo recorrido deja el token del CLI y la sesión de
  // claude.ai que necesita la extensión. El CLI queda esperando el código que
  // el usuario copia del navegador, y se lo manda `sendCode`.
  const startLogin = async (id: string) => {
    setError('');
    setNotice('');
    setLoginCode('');
    const result = await window.claudeMonitor.loginProfile(id);
    if (!result.ok) return setError(result.error);
    setPendingLogin({ id, needsExtension: result.data.needsExtension });
  };

  const sendCode = async () => {
    if (!pendingLogin || !loginCode.trim()) return;
    setError('');
    const id = pendingLogin.id;
    const result = await window.claudeMonitor.submitLoginCode(id, loginCode);
    if (!result.ok) return setError(result.error);
    setPendingLogin(null);
    setLoginCode('');
    // El paso siguiente recién ahora: instalar la extensión antes de tener la
    // sesión no sirve de nada, y abrir las dos pestañas juntas encimaba todo.
    if (pendingLogin.needsExtension) {
      await window.claudeMonitor.openChrome(id);
      setNotice(
        'Cuenta conectada. Se abrió la tienda en ese mismo Chrome: instalá ahí la extensión de Claude y ya queda todo listo.'
      );
    } else {
      setNotice('Cuenta conectada. Ese Chrome ya tiene la sesión y la extensión: la herramienta de navegador debería andar.');
    }
    await refresh();
  };

  const cancelLogin = async () => {
    if (pendingLogin) await window.claudeMonitor.cancelLogin(pendingLogin.id);
    setPendingLogin(null);
    setLoginCode('');
  };

  const run = async (action: () => Promise<Result<unknown>>) => {
    setError('');
    setNotice('');
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
          // El cambio se pinta ya. El refresco que viene detrás vuelve a
          // consultar el consumo de las cuentas y tarda medio segundo: sin
          // esto, hacés clic y no pasa nada visible hasta que termina, que se
          // lee como que el clic no funcionó. Si la llamada falla, el refresco
          // devuelve el estado real y el cambio se deshace solo.
          setProfileList((prev) => (prev ? { ...prev, activeProfileId: id } : prev));
          run(() => window.claudeMonitor.setActiveProfile(id));
        }}
        onAddAccount={async (name) => {
          setError('');
          const created = await window.claudeMonitor.createProfile(name);
          if (!created.ok) return setError(created.error);
          await refresh();
          // Agregar la cuenta y conectarla es un solo recorrido: se crea y se
          // arranca el login enseguida, en el Chrome de esa cuenta.
          await startLogin(created.data.id);
        }}
        onLogin={(id) => startLogin(id)}
        onOpenChrome={(id) => openChrome(id)}
        onNewSessionIn={(cwd) => run(() => window.claudeMonitor.newSession(cwd))}
        onDeleteProfile={(id) => {
          setSelectedSlug(null);
          run(() => window.claudeMonitor.deleteProfile(id));
        }}
      />
      <main className="main">
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {pendingLogin && (
          <form
            className="notice login-code"
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
          >
            <p>
              <strong>Autorizá en la ventana de Chrome que se abrió</strong> — es la de esta cuenta, no el Chrome
              normal. Cuando termines te va a dar un código: pegalo acá.
              {pendingLogin.needsExtension && ' Después de esto se abre la tienda para instalar la extensión.'}
            </p>
            <div className="login-code-row">
              <input
                autoFocus
                value={loginCode}
                onChange={(e) => setLoginCode(e.target.value)}
                placeholder="Pegá el código acá"
              />
              <button className="primary" type="submit" disabled={!loginCode.trim()}>
                Conectar
              </button>
              <button type="button" onClick={cancelLogin}>
                Cancelar
              </button>
            </div>
          </form>
        )}
        {loading ? (
          <p className="muted">Cargando…</p>
        ) : (
          <SessionList
            sessions={selectedSlug ? sessions.filter((s) => s.projectSlug === selectedSlug) : sessions}
            emptyHint={emptyHint}
            activeProfileName={activeProfile?.name ?? ''}
            canResume={Boolean(activeProfile?.authenticated)}
            onResume={resume}
            onDelete={(id) => run(() => window.claudeMonitor.deleteSession(id))}
            onOpen={setOpenId}
            onNewSession={() => run(() => window.claudeMonitor.newSession())}
          />
        )}
      </main>
      {openId && (
        <TranscriptView
          sessionId={openId}
          activeProfileName={activeProfile?.name ?? ''}
          canResume={Boolean(activeProfile?.authenticated)}
          onResume={() => resume(openId)}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
