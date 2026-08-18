import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import TranscriptView from './Transcript';
import SessionList from './SessionList';
import type { ProfileList, Result, SessionMeta, SessionTokens } from '../shared/types';

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
  // El consumo por sesión. Se pide aparte y sin bloquear: obliga a leer los
  // transcripts enteros —medio giga en esta máquina— y la lista tiene que
  // aparecer antes. Mientras tanto el mapa está vacío y la interfaz lo dice.
  const [tokens, setTokens] = useState<Record<string, SessionTokens>>({});
  const [tokensLoading, setTokensLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // El login en curso: el CLI ya abrió la autorización y espera el código.
  const [pendingLogin, setPendingLogin] = useState<{ id: string; name: string; needsExtension: boolean } | null>(null);
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

    // Después de pintar la lista, y sin `await` que la demore. El primer
    // recorrido tarda segundos; los siguientes releen sólo lo que cambió.
    setTokensLoading(true);
    const consumo = await window.claudeMonitor.sessionTokens().catch(() => null);
    if (mine !== runId.current) return;
    if (consumo?.ok) setTokens(consumo.data);
    setTokensLoading(false);
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

  // Abre el Chrome de una cuenta en el paso que le falte: primero la extensión,
  // después la sesión de claude.ai. Son los dos pasos que la app no puede hacer
  // por el usuario, y el aviso dice cuál es el que quedó abierto — sin eso, la
  // pestaña aparece sin explicar qué hay que hacer ahí.
  const openChrome = async (id: string) => {
    setError('');
    setNotice('');
    const result = await window.claudeMonitor.openChrome(id);
    if (!result.ok) return setError(result.error);
    const { needsExtension, needsLogin } = result.data;
    setNotice(
      needsExtension
        ? 'Paso 1: se abrió el Chrome de esta cuenta en la tienda. Instalá ahí la extensión de Claude. Las extensiones ' +
            'son por perfil, así que va una vez por cada cuenta — sin ella, la sesión dice "browser extension is not connected".'
        : needsLogin
          ? 'Paso 2: se abrió claude.ai en el Chrome de esta cuenta. Iniciá sesión ahí con ESTA cuenta y volvé acá: ' +
              'esa ventana se cierra sola cuando la app ve que ya está lista.'
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
    setPendingLogin({ id, name: profileList?.profiles.find((p) => p.id === id)?.name ?? '', needsExtension: result.data.needsExtension });
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
          setNotice('');
          const created = await window.claudeMonitor.createProfile(name);
          if (!created.ok) return setError(created.error);
          await refresh();
          // Primero el navegador, después el login del CLI. Al revés no
          // funciona: `claude auth login` abre una pestaña en el Chrome de
          // siempre, y si se autoriza ahí la sesión de claude.ai queda guardada
          // en el navegador equivocado. Con el de la cuenta ya logueado, la
          // pestaña correcta muestra el botón de autorizar directo.
          //
          // Y dentro del navegador, la extensión antes que el login: es por
          // perfil, un Chrome recién creado nunca la tiene, y es el paso que
          // nadie descubre solo. `openChrome` abre la tienda directamente.
          const abierto = await window.claudeMonitor.openChrome(created.data.id);
          if (!abierto.ok) return setError(abierto.error);
          setNotice(
            `Cuenta "${name}" creada. Se abrió su Chrome propio en la tienda: ` +
              '1) instalá ahí la extensión de Claude, 2) iniciá sesión en claude.ai en esa misma ventana, ' +
              '3) volvé acá y tocá "Configurar Claude". Usá SIEMPRE esa ventana y no tu Chrome de siempre: ' +
              'cuando los dos primeros pasos estén hechos se cierra sola.'
          );
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
              <strong>Autorizá en la ventana “Claude · {pendingLogin.name}”</strong>, no en tu Chrome de siempre.
              Como esa ventana ya tiene la sesión iniciada, te va a mostrar el botón de autorizar directo. El CLI
              abre además una pestaña en tu Chrome normal que no se puede evitar: <strong>ignorala</strong> — si
              autorizás ahí, la sesión queda guardada en el navegador equivocado. Cuando termines te da un código:
              pegalo acá.
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
            tokens={tokens}
            tokensLoading={tokensLoading}
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
