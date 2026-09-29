// electron/telegram-md.test.ts
import { describe, it, expect } from 'vitest';
import { mdAHtml } from './telegram-md';

describe('mdAHtml', () => {
  it('negrita, cursiva y código en línea', () => {
    expect(mdAHtml('**hecho** y *listo* con `npm test`')).toBe('<b>hecho</b> y <i>listo</i> con <code>npm test</code>');
  });

  it('títulos en negrita y viñetas con punto', () => {
    expect(mdAHtml('## Resumen\n- uno\n* dos\n1. tres')).toBe('<b>Resumen</b>\n• uno\n• dos\n1. tres');
  });

  it('escapa <, > y & fuera y dentro del código', () => {
    expect(mdAHtml('a < b && `x > 1`')).toBe('a &lt; b &amp;&amp; <code>x &gt; 1</code>');
  });

  it('un bloque de código queda en <pre> sin formatear lo de adentro', () => {
    expect(mdAHtml('```ts\nconst a = **b**;\n```')).toBe('<pre>const a = **b**;</pre>');
  });

  it('los guiones bajos de un identificador no se vuelven cursiva', () => {
    expect(mdAHtml('mirá snake_case_name')).toBe('mirá snake_case_name');
  });

  it('enlaces', () => {
    expect(mdAHtml('ver [docs](https://x.y/a?b=1&c=2)')).toBe('ver <a href="https://x.y/a?b=1&amp;c=2">docs</a>');
  });
});
