import { useMemo, useState } from 'react';
import type { ProfileList, SessionMeta } from '../shared/types';

type Props = {
  profileList: ProfileList | null;
  sessions: SessionMeta[];
  selectedSlug: string | null;
  onSelectSlug: (slug: string | null) => void;
  onSelectProfile: (id: string) => void;
  onAddAccount: (name: string) => void;
  onLogin: (id: string) => void;
  onDeleteProfile: (id: string) => void;
};

/** Nombre corto del proyecto: última carpeta del cwd de sus sesiones. */
function projectLabel(sessions: SessionMeta[]): string {
  const cwd = sessions[0]?.cwd ?? '';
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? sessions[0]?.projectSlug ?? '';
}

export default function Sidebar(props: Props) {
  const { profileList, sessions, selectedSlug } = props;
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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
      <h2>Cuentas</h2>
      <ul className="profiles">
        {profileList?.profiles.map((p) => (
          <li key={p.id} className={p.id === profileList.activeProfileId ? 'active' : ''}>
            <button onClick={() => props.onSelectProfile(p.id)}>
              <span className={p.authenticated ? 'dot ok' : 'dot off'} />
              {p.name}
              {!p.exists && <em> (no disponible)</em>}
            </button>
            {!p.authenticated && (
              <button className="link" onClick={() => props.onLogin(p.id)}>
                Iniciar sesión
              </button>
            )}
            {!p.isDefault && (
              <button className="link danger" onClick={() => setConfirmDelete(p.id)}>
                Quitar
              </button>
            )}
          </li>
        ))}
      </ul>

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
          <p>¿Quitar la cuenta? Se borra su carpeta de configuración y sus sesiones.</p>
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
          </li>
        ))}
      </ul>
    </aside>
  );
}
