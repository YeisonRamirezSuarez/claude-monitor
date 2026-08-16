import { useMemo, useState } from 'react';
import type { AccountUsage, ProfileList, ProfileWithStatus, SessionMeta } from '../shared/types';
import AccountIcon from './AccountIcon';
import { relativeDate } from './format';

const FULL_DATE = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });

/** Estado de consumo de una cuenta: una barra por límite, con cuándo se
 *  restablece. Los números salen de la caché que deja el propio CLI, así que
 *  se muestra su antigüedad: si la cuenta hace días que no se usa, están
 *  viejos y decirlo evita que se lean como actuales. */
function Usage({ usage }: { usage: AccountUsage | null }) {
  if (!usage || usage.limits.length === 0) return null;
  return (
    <div className="usage">
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
  onNewSessionIn: (cwd: string) => void;
  onDeleteProfile: (id: string) => void;
};

/** Nombre corto del proyecto: última carpeta del cwd de sus sesiones. */
function projectLabel(sessions: SessionMeta[]): string {
  const cwd = sessions[0]?.cwd ?? '';
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? sessions[0]?.projectSlug ?? '';
}

/** Una cuenta con su estado y su consumo. La activa no se puede "elegir": ya
 *  está elegida, así que en vez del botón lleva la marca de en uso. */
function ProfileBlock({
  profile,
  isActive,
  onLogin,
  onOpenChrome,
  onRemove,
  onSelect
}: {
  profile: ProfileWithStatus;
  isActive: boolean;
  onLogin: (id: string) => void;
  onOpenChrome: (id: string) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  // Qué le falta al Chrome de esta cuenta. Sin esto sólo se descubre fallando:
  // se abre el navegador, la extensión dice "not connected", y no hay forma de
  // saber si lo que falta es la extensión o el login.
  const falta = [
    !profile.chrome.loggedIn && 'iniciar sesión en claude.ai',
    !profile.chrome.extension && 'instalar la extensión'
  ].filter((f): f is string => Boolean(f));
  const listo = falta.length === 0;

  return (
    <li className={`profile${isActive ? ' active' : ''}`}>
      <div className="profile-row">
        {isActive ? (
          <span className="profile-name">
            <AccountIcon id={profile.id} name={profile.name} />
            <span className={profile.authenticated ? 'dot ok' : 'dot off'} />
            {profile.name}
            {!profile.exists && <em> (no disponible)</em>}
          </span>
        ) : (
          <button title={`Trabajar con "${profile.name}"`} onClick={() => onSelect(profile.id)}>
            <AccountIcon id={profile.id} name={profile.name} />
            <span className={profile.authenticated ? 'dot ok' : 'dot off'} />
            {profile.name}
            {!profile.exists && <em> (no disponible)</em>}
          </button>
        )}
        {!profile.authenticated && (
          <button className="link" onClick={() => onLogin(profile.id)}>
            Iniciar sesión
          </button>
        )}
        {/* Sin sesión iniciada no hay nada que hacer en el navegador: la
            extensión se autentica con la cuenta, así que primero el login. Con
            los dos botones a la vez, el de Chrome sólo invita a un camino que
            todavía no lleva a ningún lado. */}
        {profile.authenticated && (
          <button
            className={`link${listo ? '' : ' pendiente'}`}
            title={
              listo
                ? `Abrir el Chrome de "${profile.name}". Ya tiene la extensión y la sesión de claude.ai.`
                : `Abrir el Chrome de "${profile.name}". Falta: ${falta.join(' y ')}.`
            }
            onClick={() => onOpenChrome(profile.id)}
          >
            Chrome{listo ? ' ✓' : ' !'}
          </button>
        )}
        {!profile.isDefault && (
          <button className="link danger" onClick={() => onRemove(profile.id)}>
            Quitar
          </button>
        )}
      </div>
      {!listo && profile.authenticated && (
        <p className="chrome-falta">Para la extensión falta: {falta.join(' y ')}. Tocá “Chrome”.</p>
      )}
      {!profile.authenticated && <p className="chrome-falta">Iniciá sesión para poder usar esta cuenta.</p>}
      <Usage usage={profile.usage} />
    </li>
  );
}

export default function Sidebar(props: Props) {
  const { profileList, sessions, selectedSlug } = props;
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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
        {projects.map(([slug, group]) => (
          <li key={slug} className={slug === selectedSlug ? 'active' : ''}>
            <button onClick={() => props.onSelectSlug(slug)} title={group[0].cwd}>
              {projectLabel(group)} ({group.length})
            </button>
            <button className="link" title="Nueva sesión en este proyecto" onClick={() => props.onNewSessionIn(group[0].cwd)}>
              +
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
