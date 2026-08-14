/** Marca de qué cuenta salió algo: inicial de la cuenta sobre un color fijo.
 *  El color se deriva del id, no de la posición en la lista, así que una
 *  cuenta conserva el suyo aunque agregues o quites otras. */
const COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#2ac3de'];

export default function AccountIcon({ id, name }: { id: string; name: string }) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="avatar" style={{ background: COLORS[hash % COLORS.length] }} title={name}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}
