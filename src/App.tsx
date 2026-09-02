import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import TranscriptView from './Transcript';
import SessionList from './SessionList';
import LogsPanel from './LogsPanel';
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
  const [showLogs, setShowLogs] = useState(false);
  // Si esta app tiene el protocolo `claude://`. Decide si el login de Google de
  // Desktop se hace adentro de la ventana de cada cuenta o se va al navegador.
  const [protocoloNuestro, setProtocoloNuestro] = useState<boolean | null>(null);
  const [empaquetada, setEmpaquetada] = useState(true);

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
    window.claudeMonitor.protocolStatus().then((r) => {
      if (!r.ok) return;
      setProtocoloNuestro(r.data.nuestro);
      setEmpaquetada(r.data.empaquetada ?? true);
    });
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
    const compactada =
      result.data.compactions > 0
        ? `Esta sesión fue compactada ${result.data.compactions} ${result.data.compactions === 1 ? 'vez' : 'veces'}. ` +
          'Claude Code reanuda desde el último resumen, así que en la terminal no vas a ver los mensajes anteriores a esa compactación: están resumidos, no perdidos.'
        : '';
    // El relevo primero: cambiar de cuenta afecta a quién le sale el gasto, y
    // eso importa más que el detalle de la compactación.
    setNotice([result.data.relevo, compactada].filter(Boolean).join(' '));
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

  // Toma o devuelve el protocolo `claude://`.
  //
  // Sirve para UNA cosa: el login con Google de una ventana de Desktop. Ese
  // login sale al navegador del sistema y la respuesta vuelve como un enlace
  // `claude://` que resuelve Windows, no el navegador; con el protocolo
  // nuestro llega acá y se lo reenvía a la ventana que lo estaba esperando, en
  // vez de aterrizar en el Desktop de siempre y guardar la cuenta donde no era.
  //
  // "Reanudar en Desktop" y "Nueva en Desktop" NO dependen de esto: esos
  // enlaces se los pasa la app al ejecutable de Desktop como argumento, sin
  // que Windows tenga que resolver nada. Ver `desktop.ts` y `protocol.ts`.
  const cambiarProtocolo = async (tomar: boolean) => {
    setError('');
    setNotice('');
    const result = await (tomar ? window.claudeMonitor.claimProtocol() : window.claudeMonitor.releaseProtocol());
    if (!result.ok) return setError(result.error);
    setProtocoloNuestro(result.data.nuestro);
    setNotice(
      result.data.nuestro
        ? 'Listo: la respuesta del login con Google va a volver a la ventana de Desktop que la pidió, en vez de al ' +
            'Desktop de siempre. Reanudar y abrir carpetas en Desktop andan igual, con protocolo o sin él.'
        : 'Se devolvió el protocolo claude://. Si entrás a Desktop sólo con correo, no te hace falta. Con Google, la ' +
            'cuenta puede terminar guardada en otra ventana. La app lo vuelve a tomar sola en el próximo arranque.'
    );
  };

  // Abre el Claude Desktop de una cuenta. El aviso sólo aparece la primera vez,
  // que es cuando la ventana nace sin sesión: ahí el usuario tiene que iniciarla
  // adentro, y con la cuenta correcta — la app no puede hacerlo por él.
  const openDesktop = async (id: string) => {
    setError('');
    setNotice('');
    const result = await window.claudeMonitor.openDesktop(id);
    if (!result.ok) return setError(result.error);
    // Todas las ventanas de Desktop se ven iguales. Una abierta por fuera del
    // panel queda atrás con OTRA cuenta y parece que el panel abrió la que no
    // era: es lo primero que hay que decir, antes que cualquier otro aviso.
    const ajenas = result.data.ajenas
      ? `Ojo: hay ${result.data.ajenas} ventana(s) de Claude Desktop abierta(s) por fuera del panel, con la cuenta ` +
        'que hayas usado en el acceso directo de Windows. Se ven iguales a esta. Cerrálas para no confundirte. '
      : '';
    if (ajenas) setNotice(ajenas);
    if (result.data.yaAbierta) {
      // Sólo pasa por un doble clic pegado en el tiempo: se ignoró el segundo
      // para no relanzar dos veces por el mismo gesto. Tocando de nuevo en
      // unos segundos sí abre — no es un bloqueo permanente.
      setNotice(ajenas + 'Ya se estaba abriendo. Esperá unos segundos y volvé a tocar si no ves la ventana.');
    } else if (result.data.firstRun) {
      setNotice(
        ajenas +
          'Se abrió un Claude Desktop propio para esta cuenta, sin sesión iniciada. Iniciala ahí adentro con ESTA ' +
          'cuenta. Si entrás con Google, se va a abrir tu navegador de siempre — es así en Windows, no se puede ' +
          'evitar — y de ahí volvés solo. Si no ves la ventana de Desktop en la barra de tareas después de volver ' +
          'del navegador, tocá "Desktop" de nuevo: eso la trae de vuelta, aunque puede que tengas que repetir el login.'
      );
    }
  };

  // Abre Desktop directamente en una carpeta, con la cuenta activa.
  //
  // Es la mitad "Desktop" de reanudar. No reanuda: Desktop no acepta un id de
  // sesión, así que abre el proyecto — y ahí sus propias sesiones del CLI,
  // las de esa cuenta, le quedan al usuario en el panel lateral.
  const openDesktopIn = async (cwd?: string) => {
    setError('');
    setNotice('');
    const result = await window.claudeMonitor.openDesktopIn(cwd);
    if (!result.ok) return setError(result.error);
    if (!result.data) return; // se canceló el selector de carpeta
    const aviso = (texto: string) => setNotice([result.data?.relevo, texto].filter(Boolean).join(' '));
    aviso(
      result.data.firstRun
        ? 'Se abrió un Claude Desktop propio para esta cuenta, sin sesión iniciada. Iniciala ahí adentro, con Google o con correo. Si entrás con Google se va a abrir tu navegador de siempre — es así en Windows — y de ahí volvés solo. Si al volver no ves la ventana de Desktop, tocá el botón de nuevo: la trae de vuelta, aunque puede que tengas que repetir el login.'
        : 'Claude Desktop abrió una sesión nueva en esa carpeta. Si no ves todas tus sesiones viejas en su panel ' +
            'lateral, usá ahí “Import Claude Code CLI sessions…”: Desktop lista sólo unas pocas hasta que las importás.'
    );
  };

  // Abre una terminal nueva. Igual que reanudar, puede haber relevado la cuenta
  // por falta de cupo, y eso hay que decirlo: cambia a quién le sale el gasto.
  const nuevaEnTerminal = async (cwd?: string) => {
    setError('');
    setNotice('');
    const result = await window.claudeMonitor.newSession(cwd);
    if (!result.ok) return setError(result.error);
    if (result.data?.relevo) setNotice(result.data.relevo);
  };

  // Reanuda la misma conversación en Desktop. Desktop adopta el transcript del
  // CLI por su id, así que es continuar, no empezar de nuevo en esa carpeta.
  const resumeInDesktop = async (id: string) => {
    setError('');
    setNotice('');
    const result = await window.claudeMonitor.resumeInDesktop(id);
    if (!result.ok) return setError(result.error);
    setNotice(
      [
        result.data.relevo,
        result.data.firstRun
          ? 'Se abrió un Claude Desktop propio para esta cuenta, sin sesión iniciada. Iniciala ahí adentro, con Google o con correo. Si entrás con Google se va a abrir tu navegador de siempre — es así en Windows — y de ahí volvés solo. Si al volver no ves la ventana de Desktop, tocá el botón de nuevo: la trae de vuelta, aunque puede que tengas que repetir el login.'
          : 'Claude Desktop está importando esa conversación, con todo el historial. Al importarla reescribe el ' +
            '.jsonl para sacarle los bloques de razonamiento y deja una copia .pre-import al lado; podés seguir ' +
            'reanudándola desde la terminal igual.'
      ]
        .filter(Boolean)
        .join(' ')
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
        onOpenDesktop={(id) => openDesktop(id)}
        onNewSessionIn={(cwd) => nuevaEnTerminal(cwd)}
        onNewSessionInDesktop={(cwd) => openDesktopIn(cwd)}
        onDeleteProfile={(id) => {
          setSelectedSlug(null);
          run(() => window.claudeMonitor.deleteProfile(id));
        }}
      />
      <main className="main">
        {/* La app toma el protocolo sola al arrancar — sólo cuando está
            empaquetada. En desarrollo (`npm run dev`) el registro es el de
            `electron.exe` más la ruta del proyecto, y esa ruta partida en un
            espacio es justo lo que mandaba a Desktop a abrir la app equivocada.
            Ver `protocol.ts`. */}
        {protocoloNuestro === false && !empaquetada && (
          <p className="muted protocolo">
            En modo desarrollo esta app no toma el protocolo <code>claude://</code>: entrar a Desktop con Google puede
            guardar la cuenta en la ventana equivocada. Con la app instalada (no <code>npm run dev</code>) se toma solo.
          </p>
        )}
        {protocoloNuestro === false && empaquetada && (
          <div className="notice protocolo">
            Esta app no tiene el protocolo <code>claude://</code>. Sólo importa si entrás a Claude Desktop con Google:
            la respuesta vuelve del navegador por ese enlace y, sin él, aterriza en el Desktop de siempre en vez de en
            la ventana de la cuenta que la pidió. Entrando con correo no hace falta.
            <button className="link" onClick={() => cambiarProtocolo(true)}>
              Tomarlo ahora
            </button>
          </div>
        )}
        {protocoloNuestro === true && (
          <p className="muted protocolo-ok">
            El login con Google de Desktop vuelve a la ventana que lo pidió. Entrando con correo esto no hace falta.
            <button className="link" onClick={() => cambiarProtocolo(false)}>
              Devolver el protocolo
            </button>
          </p>
        )}
        {/* Siempre visible: es lo primero que hay que abrir cuando algo con
            Desktop o con el protocolo no funciona como se espera. */}
        <button className="link logs-toggle" onClick={() => setShowLogs(true)}>
          Ver registro
        </button>
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
            onResumeInDesktop={resumeInDesktop}
            onDelete={(id) => run(() => window.claudeMonitor.deleteSession(id))}
            onOpen={setOpenId}
            onNewSession={() => nuevaEnTerminal()}
            onNewSessionInDesktop={() => openDesktopIn()}
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
      {showLogs && (
        <LogsPanel
          profileId={activeProfile?.id ?? null}
          profileName={activeProfile?.name ?? ''}
          onClose={() => setShowLogs(false)}
        />
      )}
    </div>
  );
}