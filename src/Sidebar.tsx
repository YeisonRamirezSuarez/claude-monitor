import { useMemo, useState } from 'react';
import type { AccountUsage, Entorno, ProfileList, ProfileWithStatus, Raiz, SessionMeta } from '../shared/types';
import AccountIcon from './AccountIcon';
import {
  estadoDeSesion,
  hablarDeChrome,
  motivoDeshabilitado,
  projectName,
  relativeDate,
  seLeMiroElDisco
} from './format';

const FULL_DATE = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });

/** Estado de consumo de una cuenta: una barra por límite, con cuándo se
 *  restablece. Los números salen de la caché que deja el propio CLI, así que
 *  se muestra su antigüedad: si la cuenta hace días que no se usa, están
 *  viejos y decirlo evita que se lean como actuales. */
function Usage({ usage }: { usage: AccountUsage | null }) {
  if (!usage) return null;
  // Sin límites que mostrar queda el nombre de la cuenta, que es la mitad del
  // valor de este bloque: saber con qué correo trabaja esa tarjeta. Antes se
  // ocultaba todo y la cuenta parecía a medio configurar.
  if (usage.limits.length === 0) {
    return (
      <div className="usage cacheada">
        {usage.email && (
          <p className="usage-account" title={usage.email}>
            {usage.email}
            {usage.plan && <span className="muted"> · {usage.plan.replace('claude_', '')}</span>}
          </p>
        )}
        <p className="muted">
          Sin datos de consumo al día. Usá la cuenta una vez —terminal o Desktop— y vuelven.
        </p>
      </div>
    );
  }
  // Los números de la caché se ven igual de firmes que los de la API, y la
  // única diferencia estaba en una línea gris al final. Atenuado, la barra
  // misma avisa que no es de ahora.
  return (
    <div className={`usage${usage.live ? '' : ' cacheada'}`}>
      {usage.email && (
        <p className="usage-account" title={usage.accountName ? `${usage.accountName} · ${usage.email}` : usage.email}>
          {usage.accountName ? `${usage.accountName} — ` : ''}
          {usage.email}
          {usage.plan && <span className="muted"> · {usage.plan.replace('claude_', '')}</span>}
        </p>
      )}
      {usage.limits.map((l) => (
        <div key={l.kind} className="usage-limit">
          <p>
            <span>{l.label}</span>
            <span>{l.percent}%</span>
          </p>
          <div className={`bar sev-${l.severity}`}>
            <div style={{ width: `${l.percent}%` }} />
          </div>
          {l.resetsAt && (
            <p className="muted" title={FULL_DATE.format(new Date(l.resetsAt))}>
              se restablece {relativeDate(Date.parse(l.resetsAt))}
            </p>
          )}
        </div>
      ))}
      <p className="muted">
        {usage.live ? 'en vivo' : usage.fetchedAtMs > 0 ? `caché del CLI, de ${relativeDate(usage.fetchedAtMs)}` : 'caché del CLI'}
      </p>
    </div>
  );
}

type Props = {
  profileList: ProfileList | null;
  sessions: SessionMeta[];
  /** El estado de cada raíz de lectura, una por cuenta WSL más el pozo
   *  compartido de Windows. Ninguno es silencioso: sirve para decir "distro
   *  apagada" en vez de una lista corta y muda. */
  raices: Raiz[];
  selectedSlug: string | null;
  onSelectSlug: (slug: string | null) => void;
  onSelectProfile: (id: string) => void;
  onAddAccount: (name: string) => void;
  /** Da de alta una cuenta que vive en una distro de WSL, ya elegida entre las
   *  que devolvió `listarDistrosWsl`. */
  onAddWslAccount: (name: string, distro: string) => void;
  /** Enciende la distro de una cuenta. Sólo se llama desde el botón
   *  "Encender": es el único lugar de toda la app que lo hace. */
  onEncenderDistro: (distro: string) => void;
  onLogin: (id: string) => void;
  onOpenChrome: (id: string) => void;
  onOpenDesktop: (id: string) => void;
  onNewSessionIn: (cwd: string) => void;
  onNewSessionInDesktop: (cwd: string) => void;
  onDeleteProfile: (id: string) => void;
};

/** Nombre corto del proyecto: última carpeta del cwd de sus sesiones. */
function projectLabel(sessions: SessionMeta[]): string {
  return projectName(sessions[0]?.cwd ?? '') || sessions[0]?.projectSlug || '';
}

/**
 * El punto que acompaña al nombre, en cuatro estados y no en dos.
 *
 * `ok` es una sesión con fecha de vencimiento en el futuro: se sabe. `guess` es
 * una sesión que se da por viva porque hay token de renovación, pero el archivo
 * no dice hasta cuándo — el CLI la puede rechazar y la app no se entera hasta
 * que la terminal lo diga. Pintarlos iguales era prometer de más.
 *
 * `sin-mirar` es el cuarto, y es el que evita mentir: con la distro de una
 * cuenta WSL apagada nadie le leyó el disco, así que el `authenticated:false`
 * que llega de `sinMirar` no significa "sin sesión" sino "no se sabe". Ver
 * `estadoDeSesion` en `format.ts`, donde está la decisión y su test.
 */
function dotState(profile: ProfileWithStatus, raiz: Raiz | undefined): { className: string; title: string } {
  switch (estadoDeSesion(profile, raiz)) {
    case 'sin-mirar':
      return {
        className: 'dot sin-mirar',
        title:
          `No se pudo mirar: ${(raiz?.estado.tipo !== 'ok' && raiz?.estado.mensaje) || 'la distro está apagada'}. ` +
          'La app no la enciende sola para averiguarlo — tocá "Encender" y vuelve a mirar.'
      };
    case 'sin-sesion':
      return { className: 'dot off', title: 'Sin sesión: hay que autorizar el CLI.' };
    case 'suposicion':
      return {
        className: 'dot guess',
        title:
          'Sesión probablemente viva: hay token de renovación, pero el archivo no dice hasta cuándo. ' +
          'Si venció, lo vas a ver recién al abrir la terminal.'
      };
    default:
      return {
        className: 'dot ok',
        title: `Sesión válida hasta ${FULL_DATE.format(new Date(profile.authExpiresAt as number))}.`
      };
  }
}

/**
 * Qué decir del navegador de una cuenta, y con cuánta seguridad.
 *
 * Un `✓` que en realidad significa "esto lo vi alguna vez" era la parte menos
 * confiable de la tarjeta: el registro en disco nunca baja un estado bueno
 * cuando no puede leer los archivos de Chrome —a propósito, para no inventar
 * avisos falsos— así que sobrevive intacto aunque el perfil haya cambiado.
 * Ahora se distingue: verificado recién va firme, lo demás va con su edad.
 */
function chromeLabel(profile: ProfileWithStatus, listo: boolean, falta: string[]): { text: string; title: string } {
  const marca = listo ? '✓' : '!';
  const detalle = listo ? 'Tiene la extensión y la sesión de claude.ai.' : `Falta: ${falta.join(' y ')}.`;
  if (profile.chrome.verified) {
    return { text: `Chrome ${marca}`, title: `Abrir el Chrome de "${profile.name}". ${detalle} Verificado recién.` };
  }
  if (profile.chrome.seenAt === 0) {
    return {
      text: 'Chrome ?',
      title: `Abrir el Chrome de "${profile.name}". Nunca se pudo mirar este perfil, así que no se sabe qué tiene.`
    };
  }
  return {
    text: `Chrome ${marca}·${relativeDate(profile.chrome.seenAt)}`,
    title:
      `Abrir el Chrome de "${profile.name}". ${detalle} Pero no se pudo verificar ahora: ` +
      `esto es lo último que se vio, ${relativeDate(profile.chrome.seenAt)}.`
  };
}

/** Una cuenta con su estado y su consumo. La activa no se puede "elegir": ya
 *  está elegida, así que en vez del botón lleva la marca de en uso. */
function ProfileBlock({
  profile,
  isActive,
  raiz,
  onLogin,
  onOpenChrome,
  onOpenDesktop,
  onEncenderDistro,
  onRemove,
  onSelect
}: {
  profile: ProfileWithStatus;
  isActive: boolean;
  /** La raíz de esta cuenta, si vive en WSL. `undefined` para una cuenta de
   *  Windows: comparten el pozo y no tienen un estado propio que mostrar. */
  raiz: Raiz | undefined;
  onLogin: (id: string) => void;
  onOpenChrome: (id: string) => void;
  onOpenDesktop: (id: string) => void;
  onEncenderDistro: (distro: string) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  // La distro de esta cuenta, si vive en WSL. `null` en Windows: ahí no hay
  // nada que encender.
  const distro = profile.entorno?.tipo === 'wsl' ? profile.entorno.distro : null;

  // Qué le falta al Chrome de esta cuenta. Sin esto sólo se descubre fallando:
  // se abre el navegador, la extensión dice "not connected", y no hay forma de
  // saber si lo que falta es la extensión o el login.
  // El orden es el mismo que sigue la app al abrir Chrome (`nextStepUrl`):
  // primero la extensión, después la sesión. Listarlo al revés mandaba al
  // usuario a un paso distinto del que le iba a abrir el botón.
  const falta = [
    !profile.chrome.extension && 'instalar la extensión',
    !profile.chrome.loggedIn && 'iniciar sesión en claude.ai'
  ].filter((f): f is string => Boolean(f));
  const listo = falta.length === 0;
  const dot = dotState(profile, raiz);
  const chrome = chromeLabel(profile, listo, falta);
  // Si lo que se afirma de esta cuenta salió de leerle el disco. Con la distro
  // apagada NO: `sinMirar` devuelve exists/authenticated en false porque se
  // negó a leer, no porque haya leído. Ver `seLeMiroElDisco` en `format.ts`.
  const seMiro = seLeMiroElDisco(profile.entorno, raiz);
  // Y si tiene sentido nombrarle la extensión de Chrome. En una cuenta WSL
  // nunca: el puente no llega a la distro, así que ese cartel no sólo sería
  // falso, sería permanente.
  const conChrome = hablarDeChrome(profile.entorno);

  return (
    <li className={`profile${isActive ? ' active' : ''}`}>
      {/* El nombre en su propia fila y los botones abajo. En una sola fila no
          entran: el nombre de una cuenta lo escribe el usuario y puede ser
          largo, y al lado van hasta tres acciones. Apretados, el nombre se
          encimaba con el primer botón. */}
      <div className="profile-row">
        {isActive ? (
          <span className="profile-name">
            <AccountIcon id={profile.id} name={profile.name} />
            <span className={dot.className} title={dot.title} />
            <span className="profile-label">
              {profile.name}
              {/* "(no disponible)" es una afirmación sobre el disco, así que
                  sólo se dice cuando se pudo mirar. Con la distro apagada, lo
                  que corresponde decir lo dice la línea de estado de la raíz. */}
              {seMiro && !profile.exists && <em> (no disponible)</em>}
            </span>
          </span>
        ) : (
          <button
            className="profile-name"
            title={`Trabajar con "${profile.name}"`}
            onClick={() => onSelect(profile.id)}
          >
            <AccountIcon id={profile.id} name={profile.name} />
            <span className={dot.className} title={dot.title} />
            <span className="profile-label">
              {profile.name}
              {/* "(no disponible)" es una afirmación sobre el disco, así que
                  sólo se dice cuando se pudo mirar. Con la distro apagada, lo
                  que corresponde decir lo dice la línea de estado de la raíz. */}
              {seMiro && !profile.exists && <em> (no disponible)</em>}
            </span>
          </button>
        )}
      </div>
      <div className="profile-actions">
        {/* No dice "Iniciar sesión" porque no es sólo eso: el botón lleva el
            paso que falte —instalar la extensión, iniciar sesión en claude.ai,
            autorizar el CLI— y recién el último es el login. Prometiendo sólo
            el login, los dos primeros parecían un desvío en vez del trámite. */}
        {!profile.authenticated && (
          <button
            className="link"
            title={
              !conChrome
                ? // En WSL el trámite es uno solo —autorizar el CLI adentro de
                  // la distro— y los pasos de Chrome ni se corren (ver
                  // `profiles:login` en main.ts). Y con la distro apagada ni
                  // siquiera se sabe si hace falta.
                  `Configurar "${profile.name}": autoriza el CLI adentro de ${distro}. ` +
                  (seMiro ? '' : 'Con la distro apagada no se pudo mirar si ya está autorizado.')
                : falta.length > 0
                  ? `Configurar "${profile.name}". Falta: ${falta.join(' y ')}, y autorizar el CLI.`
                  : `Configurar "${profile.name}". Sólo falta autorizar el CLI.`
            }
            onClick={() => onLogin(profile.id)}
          >
            Configurar Claude
          </button>
        )}
        {/* Sin sesión iniciada no hay nada que hacer en el navegador: la
            extensión se autentica con la cuenta, así que primero el login. Con
            los dos botones a la vez, el de Chrome sólo invita a un camino que
            todavía no lleva a ningún lado. */}
        {/* Y tampoco para una cuenta WSL, por el mismo motivo que los párrafos
            de abajo: la etiqueta de este botón ES una afirmación sobre la
            extensión —"Chrome !", "Falta: instalar la extensión y iniciar
            sesión en claude.ai"— y ahí no puede dejar de ser falsa nunca,
            porque `chrome.extension` y `chrome.loggedIn` no van a ser true en
            una distro. Dejarlo mientras se bifurca la prosa dejaba la
            contradicción a la vista en la misma tarjeta. */}
        {conChrome && profile.authenticated && (
          <button
            className={`link${listo ? '' : ' pendiente'}${profile.chrome.verified ? '' : ' incierto'}`}
            title={chrome.title}
            onClick={() => onOpenChrome(profile.id)}
          >
            {chrome.text}
          </button>
        )}
        {/* Va sin condición de `authenticated` a propósito: el login de Desktop
            no es el del CLI —la app guarda su token en su propia carpeta de
            datos— así que este botón es un camino de entrada por sí solo, no un
            paso posterior. Ver `desktop.ts`. */}
        <button
          className="link"
          title={`Abrir el Claude Desktop de "${profile.name}", con su propia carpeta de datos y su propio login.`}
          onClick={() => onOpenDesktop(profile.id)}
        >
          Desktop
        </button>
        {!profile.isDefault && (
          <button className="link danger" onClick={() => onRemove(profile.id)}>
            Quitar
          </button>
        )}
      </div>
      {/* Toda la prosa de la extensión es de Windows. En una cuenta WSL
          `chrome.extension` y `chrome.loggedIn` no van a ser true nunca —el
          puente es un `.bat` de Windows y el CLI corre en Linux—, así que este
          cartel sería permanente y falso incluso con la distro encendida y la
          cuenta autorizada. Ver `hablarDeChrome` en `format.ts`. */}
      {conChrome && !listo && profile.authenticated && (
        <p className="chrome-falta">
          Para la extensión falta: {falta.join(' y ')}. Tocá “Chrome”.
          {!profile.chrome.verified && profile.chrome.seenAt > 0 && (
            <span className="muted"> (visto {relativeDate(profile.chrome.seenAt)}, no verificado ahora)</span>
          )}
        </p>
      )}
      {/* Y esto sólo se dice cuando se pudo mirar: con la distro apagada,
          `authenticated:false` no significa "sin sesión" sino "no se sabe", y
          quien habla es la línea de estado de la raíz, acá abajo. */}
      {!profile.authenticated && seMiro && (
        <p className="chrome-falta">
          {!conChrome
            ? `Tocá “Configurar Claude” para autorizar el CLI adentro de ${distro} y poder usar esta cuenta.`
            : falta.length > 0
              ? `Tocá “Configurar Claude”: primero hay que ${falta.join(', y después ')} en el Chrome de esta cuenta.`
              : 'Tocá “Configurar Claude” para autorizar el CLI y poder usar esta cuenta.'}
        </p>
      )}
      {/* El estado de la raíz de esta cuenta, cuando vive en WSL y no está
          `ok`: "distro apagada", "sin distro", etc. Ninguno es silencioso —
          por eso viaja con `mensaje` desde `electron/wsl.ts` en vez de dejar
          que la lista corta y muda hable sola. */}
      {distro && raiz && raiz.estado.tipo !== 'ok' && (
        <div className="estado-raiz">
          <span>{raiz.estado.mensaje}</span>
          {raiz.estado.tipo === 'apagada' && <button onClick={() => onEncenderDistro(distro)}>Encender</button>}
        </div>
      )}
      <Usage usage={profile.usage} />
    </li>
  );
}

export default function Sidebar(props: Props) {
  const { profileList, sessions, raices, selectedSlug } = props;
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** El proyecto cuyo "+" está desplegado, o null. Uno por vez. */
  const [nuevoEn, setNuevoEn] = useState<string | null>(null);
  // Distros de WSL ofrecidas por "Agregar cuenta de WSL", o null si el panel
  // no está desplegado. Se piden recién al tocar el botón: no hay
  // autodetección silenciosa (§5.1 del spec).
  const [wslDistros, setWslDistros] = useState<string[] | null>(null);
  const [wslLoading, setWslLoading] = useState(false);
  const [wslError, setWslError] = useState('');
  const [wslName, setWslName] = useState('');
  const [wslDistro, setWslDistro] = useState('');

  // La raíz de lectura de una cuenta, por su `configDir`. `undefined` para una
  // cuenta de Windows: comparten el pozo y no tienen una raíz propia que
  // mostrar acá.
  const raizDe = (p: ProfileWithStatus) => raices.find((r) => r.configDir === p.configDir);

  // La cuenta activa se saca de la lista de elegibles y se muestra arriba,
  // sola: es la que va a consumir los tokens, y volver a "elegirla" no hace
  // nada. Verla mezclada con las demás era la forma más fácil de perderle el
  // rastro a cuál estaba en uso.
  const active = profileList?.profiles.find((p) => p.id === profileList.activeProfileId) ?? null;
  const others = profileList?.profiles.filter((p) => p.id !== profileList.activeProfileId) ?? [];
  // La cuenta que se está por quitar: lo que se borra —y lo que no— depende de
  // dónde vive su carpeta. Ver el texto de la confirmación.
  const aBorrar = profileList?.profiles.find((p) => p.id === confirmDelete) ?? null;
  // El entorno de la cuenta activa, que es lo que decide si "Desktop" del
  // desplegable del "+" va deshabilitado: Desktop es una app de Windows y no
  // puede hospedar una sesión de la distro (§7). Crear en terminal sí anda con
  // el lanzador de WSL (Task 14). Windows por defecto si no hay cuenta activa,
  // igual que en SessionList.
  const activeProfileEntorno: Entorno = active?.entorno ?? { tipo: 'windows' };

  // `sessions` llega ordenada por mtime descendente desde electron/sessions.ts,
  // así que group[0] es la sesión más reciente del proyecto.
  const projects = useMemo(() => {
    const groups = new Map<string, SessionMeta[]>();
    for (const s of sessions) {
      const group = groups.get(s.projectSlug) ?? [];
      group.push(s);
      groups.set(s.projectSlug, group);
    }
    return [...groups.entries()].sort((a, b) => b[1][0].mtime - a[1][0].mtime);
  }, [sessions]);

  return (
    <aside className="sidebar">
      <h2>Cuenta de trabajo</h2>
      {active ? (
        <ul className="profiles">
          <ProfileBlock
            profile={active}
            isActive
            raiz={raizDe(active)}
            onLogin={props.onLogin}
            onOpenChrome={props.onOpenChrome}
            onOpenDesktop={props.onOpenDesktop}
            onEncenderDistro={props.onEncenderDistro}
            onRemove={setConfirmDelete}
            onSelect={props.onSelectProfile}
          />
        </ul>
      ) : (
        <p className="muted">Ninguna.</p>
      )}

      {others.length > 0 && (
        <>
          <h2>Otras cuentas</h2>
          <ul className="profiles">
            {others.map((p) => (
              <ProfileBlock
                key={p.id}
                profile={p}
                isActive={false}
                raiz={raizDe(p)}
                onLogin={props.onLogin}
                onOpenChrome={props.onOpenChrome}
                onOpenDesktop={props.onOpenDesktop}
                onEncenderDistro={props.onEncenderDistro}
                onRemove={setConfirmDelete}
                onSelect={props.onSelectProfile}
              />
            ))}
          </ul>
        </>
      )}

      <form
        className="add-account"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          props.onAddAccount(newName);
          setNewName('');
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nombre de la cuenta" />
        <button type="submit">Agregar</button>
      </form>

      {/* Alta explícita y no autodetección: recién acá se corre la detección
          de distros, y sólo para mostrarla — dar de alta sigue siendo un paso
          aparte que el usuario confirma. Ver §5.1 del spec de WSL. */}
      {wslDistros === null ? (
        <button
          type="button"
          className="link"
          disabled={wslLoading}
          onClick={async () => {
            setWslError('');
            setWslLoading(true);
            const result = await window.claudeMonitor.listarDistrosWsl();
            setWslLoading(false);
            if (!result.ok) return setWslError(result.error);
            if (result.data.length === 0) return setWslError('No se encontró ninguna distro de WSL instalada.');
            setWslDistro(result.data[0]);
            setWslDistros(result.data);
          }}
        >
          {wslLoading ? 'Buscando distros…' : 'Agregar cuenta de WSL'}
        </button>
      ) : (
        <form
          className="add-account"
          onSubmit={(e) => {
            e.preventDefault();
            if (!wslName.trim() || !wslDistro) return;
            props.onAddWslAccount(wslName, wslDistro);
            setWslName('');
            setWslDistros(null);
          }}
        >
          <input value={wslName} onChange={(e) => setWslName(e.target.value)} placeholder="Nombre de la cuenta" />
          <select value={wslDistro} onChange={(e) => setWslDistro(e.target.value)}>
            {wslDistros.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button type="submit">Agregar</button>
          <button type="button" className="link" onClick={() => setWslDistros(null)}>
            Cancelar
          </button>
        </form>
      )}
      {wslError && <p className="muted">{wslError}</p>}

      {confirmDelete && (
        <div className="confirm">
          {/* Para una cuenta WSL las tres promesas del texto de siempre son
              falsas: `sePuedeBorrarDelDisco` impide tocar su carpeta (es
              adoptada, no la creó la app), el login sobrevive porque vive ahí
              adentro, y sus conversaciones nunca fueron parte del pozo
              compartido. Con el texto equivocado, quitarla da miedo de perder
              el ~/.claude real de Linux. */}
          <p>
            {aBorrar?.entorno?.tipo === 'wsl'
              ? `¿Quitar la cuenta? Sólo se da de baja del panel: su ~/.claude adentro de ${aBorrar.entorno.distro} —configuración, sesión iniciada y conversaciones— queda intacto. Volver a agregarla la recupera tal cual.`
              : '¿Quitar la cuenta? Se borra su configuración y su sesión iniciada. Las conversaciones no se tocan: son compartidas por todas las cuentas.'}
          </p>
          <button
            className="danger"
            onClick={() => {
              props.onDeleteProfile(confirmDelete);
              setConfirmDelete(null);
            }}
          >
            Quitar
          </button>
          <button onClick={() => setConfirmDelete(null)}>Cancelar</button>
        </div>
      )}

      <h2>Proyectos</h2>
      <ul className="projects">
        <li className={selectedSlug === null ? 'active' : ''}>
          <button onClick={() => props.onSelectSlug(null)}>Todos ({sessions.length})</button>
        </li>
        {/* El "+" no abre nada por sí solo: despliega dónde. Hay dos lugares
            para trabajar y el botón no puede elegir por el usuario — antes
            abría siempre la terminal y no había forma de pedir Desktop. */}
        {projects.map(([slug, group]) => (
          <li key={slug} className={slug === selectedSlug ? 'active' : ''}>
            <button onClick={() => props.onSelectSlug(slug)} title={group[0].cwd}>
              {projectLabel(group)} ({group.length})
            </button>
            <button
              className="link"
              title="Nueva sesión en este proyecto"
              aria-expanded={nuevoEn === slug}
              onClick={() => setNuevoEn(nuevoEn === slug ? null : slug)}
            >
              +
            </button>
            {nuevoEn === slug && (
              <div className="nueva-en">
                {/* Igual que la barra de SessionList: crear en terminal con
                    la cuenta activa usa el lanzador de WSL (Task 14), ya no
                    se deshabilita. */}
                <button
                  className="link"
                  onClick={() => {
                    setNuevoEn(null);
                    props.onNewSessionIn(group[0].cwd);
                  }}
                >
                  Terminal
                </button>
                <button
                  className="link"
                  disabled={activeProfileEntorno.tipo === 'wsl'}
                  title={motivoDeshabilitado(activeProfileEntorno)}
                  onClick={() => {
                    setNuevoEn(null);
                    props.onNewSessionInDesktop(group[0].cwd);
                  }}
                >
                  Desktop
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
