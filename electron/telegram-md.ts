/**
 * El Markdown que escribe el agente, en el HTML que entiende Telegram.
 *
 * Mandado como texto plano, lo que el agente contesta llegaba al celular con
 * los `**`, `###` y backticks a la vista. Telegram acepta un HTML chico (b, i,
 * code, pre, a); esto convierte lo común y escapa el resto. Si igual Telegram
 * rechaza el resultado, `Telegram.enviar` lo reenvía plano: nunca se pierde.
 */

const escapar = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function mdAHtml(md: string): string {
  // Lo que es código no se toca: se aparta, se formatea el resto y se repone.
  const apartados: string[] = [];
  const apartar = (html: string) => `\u0000${apartados.push(html) - 1}\u0000`;

  let s = md.replace(/```[^\n]*\n([\s\S]*?)\n?```/g, (_, codigo: string) => apartar(`<pre>${escapar(codigo)}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, codigo: string) => apartar(`<code>${escapar(codigo)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, url: string) =>
    apartar(`<a href="${escapar(url).replace(/"/g, '&quot;')}">${escapar(t)}</a>`)
  );

  s = escapar(s)
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    // Cursiva sólo con asteriscos pegados al texto: `_` aparece en identificadores.
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<i>$2</i>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => apartados[Number(i)]);
}
