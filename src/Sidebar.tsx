import { useMemo, useState } from 'react';
import type { AccountUsage, ProfileList, ProfileWithStatus, SessionMeta } from '../shared/types';
import AccountIcon from './AccountIcon';
import { projectName, relativeDate } from './format';

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
  selectedSlug: string | null;
  onSelectSlug: (slug: string | null) => void;
  onSelectProfile: (id: string) => void;
  onAddAccount: (name: string) => void;
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
 * El punto que acompaña al nombre, en tres estados y no en dos.
 *
 * `ok` es una sesión con fecha de vencimiento en el futuro: se sabe. `guess` es
 * una sesión que se da por viva porque hay token de renovación, pero el archivo
 * no dice hasta cuándo — el CLI la puede rechazar y la app no se entera hasta
 * que la terminal lo diga. Pintarlos iguales era prometer de más.
 */
function dotState(profile: ProfileWithStatus): { className: string; title: string } {
  if (!profile.authenticated) return { className: 'dot off', title: 'Sin sesión: hay que autorizar el CLI.' };
  if (profile.authExpiresAt === null) {
    return {
      className: 'dot guess',
      title:
        'Sesión probablemente viva: hay token de renovación, pero el archivo no dice hasta cuándo. ' +
        'Si venció, lo vas a ver recién al abrir la terminal.'
    };
  }
  return { className: 'dot ok', title: `Sesión válida hasta ${FULL_DATE.format(new Date(profile.authExpiresAt))}.` };
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
  onLogin,
  onOpenChrome,
  onOpenDesktop,
  onRemove,
  onSelect
}: {
  profile: ProfileWithStatus;
  isActive: boolean;
  onLogin: (id: string) => void;
  onOpenChrome: (id: string) => void;
  onOpenDesktop: (id: string) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
}) {
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
  const dot = dotState(profile);
  const chrome = chromeLabel(profile, listo, falta);

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
              {!profile.exists && <em> (no disponible)</em>}
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
              {!profile.exists && <em> (no disponible)</em>}
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
              falta.length > 0
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
        {profile.authenticated && (
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
      {!listo && profile.authenticated && (
        <p className="chrome-falta">
          Para la extensión falta: {falta.join(' y ')}. Tocá “Chrome”.
          {!profile.chrome.verified && profile.chrome.seenAt > 0 && (
            <span className="muted"> (visto {relativeDate(profile.chrome.seenAt)}, no verificado ahora)</span>
          )}
        </p>
      )}
      {!profile.authenticated && (
        <p className="chrome-falta">
          {falta.length > 0
            ? `Tocá “Configurar Claude”: primero hay que ${falta.join(', y después ')} en el Chrome de esta cuenta.`
            : 'Tocá “Configurar Claude” para autorizar el CLI y poder usar esta cuenta.'}
        </p>
      )}
      <Usage usage={profile.usage} />
    </li>
  );
}

export default function Sidebar(props: Props) {
  const { profileList, sessions, selectedSlug } = props;
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** El proyecto cuyo "+" está desplegado, o null. Uno por vez. */
  const [nuevoEn, setNuevoEn] = useState<string | null>(null);

  // La cuenta activa se saca de la lista de elegibles y se muestra arriba,
  // sola: es la que va a consumir los tokens, y volver a "elegirla" no hace
  // nada. Verla mezclada con las demás era la forma más fácil de perderle el
  // rastro a cuál estaba en uso.
  const active = profileList?.profiles.find((p) => p.id === profileList.activeProfileId) ?? null;
  const others = profileList?.profiles.filter((p) => p.id !== profileList.activeProfileId) ?? [];

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
            onLogin={props.onLogin}
            onOpenChrome={props.onOpenChrome}
            onOpenDesktop={props.onOpenDesktop}
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
                onLogin={props.onLogin}
                onOpenChrome={props.onOpenChrome}
                onOpenDesktop={props.onOpenDesktop}
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

      {confirmDelete && (
        <div className="confirm">
          <p>
            ¿Quitar la cuenta? Se borra su configuración y su sesión iniciada. Las conversaciones no se
            tocan: son compartidas por todas las cuentas.
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
