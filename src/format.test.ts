import { describe, expect, it } from 'vitest';
import type { Raiz, SessionMeta } from '../shared/types';
import {
  agruparLinajes,
  estadoDeSesion,
  etiquetaDeEntorno,
  hablarDeChrome,
  motivoDeshabilitado,
  procedenciaDeConsumo,
  raizDeCuenta,
  raizUNC,
  raicesMudas,
  seLeMiroElDisco,
  textoDeMotivo
} from './format';

const WSL = { tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' } as const;
const raizCon = (estado: Raiz['estado']): Raiz => ({
  configDir: '\\\\wsl.localhost\\Ubuntu\\home\\v\\.claude',
  entorno: WSL,
  estado
});

describe('etiquetaDeEntorno', () => {
  it('las de Windows no llevan marca: son la mayoría y la marca sería ruido', () => {
    expect(etiquetaDeEntorno({ tipo: 'windows' })).toBe('');
  });
  it('las de WSL llevan la distro', () => {
    expect(etiquetaDeEntorno({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' })).toBe('Ubuntu');
  });
});

describe('motivoDeshabilitado', () => {
  const UBUNTU = { tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' } as const;

  it('borrar es una decisión de producto, no una imposibilidad', () => {
    expect(motivoDeshabilitado(UBUNTU)).toBe('Borrar sesiones de Ubuntu no está disponible todavía');
  });

  // El botón estaba habilitado con un tooltip que prometía seguir la
  // conversación, y el handler la rechazaba siempre: el motivo va antes del clic.
  it('reanudar en Desktop dice por qué no y qué hacer en cambio', () => {
    const motivo = motivoDeshabilitado(UBUNTU, 'desktop');
    expect(motivo).toContain('adentro de Ubuntu');
    expect(motivo).toContain('Reanudala en terminal');
  });

  it('en Windows no hay motivo: los botones andan', () => {
    expect(motivoDeshabilitado({ tipo: 'windows' })).toBe('');
    expect(motivoDeshabilitado({ tipo: 'windows' }, 'desktop')).toBe('');
  });
});
;

describe('seLeMiroElDisco', () => {
  it('una cuenta de Windows siempre se mira', () => {
    expect(seLeMiroElDisco({ tipo: 'windows' }, undefined)).toBe(true);
    expect(seLeMiroElDisco(undefined, undefined)).toBe(true);
  });

  it('con la distro apagada no se miró nada: tocar la UNC la encendería', () => {
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'apagada', mensaje: 'Distro apagada' }))).toBe(false);
  });

  it('sin la distro instalada tampoco', () => {
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'sin-distro', mensaje: 'La distro Ubuntu ya no está' }))).toBe(
      false
    );
  });

  it('con la distro corriendo sí se miró, aunque falte algo adentro', () => {
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'ok' }))).toBe(true);
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'sin-config', mensaje: 'x' }))).toBe(true);
    expect(seLeMiroElDisco(WSL, raizCon({ tipo: 'sin-cli', mensaje: 'x' }))).toBe(true);
  });

  it('sin raíz todavía no se miró nada: no es lo mismo que no haber encontrado nada', () => {
    expect(seLeMiroElDisco(WSL, undefined)).toBe(false);
  });
});

describe('estadoDeSesion', () => {
  it('una cuenta WSL con la distro apagada no está "sin sesión": no se sabe', () => {
    // Es el hallazgo: `sinMirar` devuelve authenticated:false porque se NEGÓ a
    // leer, no porque haya leído un archivo vacío.
    const cuenta = { entorno: WSL, authenticated: false, authExpiresAt: null };
    expect(estadoDeSesion(cuenta, raizCon({ tipo: 'apagada', mensaje: 'Distro apagada' }))).toBe('sin-mirar');
  });

  it('con la distro corriendo y sin credenciales sí está sin sesión', () => {
    const cuenta = { entorno: WSL, authenticated: false, authExpiresAt: null };
    expect(estadoDeSesion(cuenta, raizCon({ tipo: 'ok' }))).toBe('sin-sesion');
  });

  it('los tres estados de siempre en Windows no cambian', () => {
    const base = { entorno: { tipo: 'windows' } as const };
    expect(estadoDeSesion({ ...base, authenticated: false, authExpiresAt: null }, undefined)).toBe('sin-sesion');
    expect(estadoDeSesion({ ...base, authenticated: true, authExpiresAt: null }, undefined)).toBe('suposicion');
    expect(estadoDeSesion({ ...base, authenticated: true, authExpiresAt: 1 }, undefined)).toBe('viva');
  });
});

describe('hablarDeChrome', () => {
  it('a una cuenta de WSL nunca: la extensión no llega a la distro', () => {
    expect(hablarDeChrome(WSL)).toBe(false);
  });
  it('en Windows sí, que es donde el puente existe', () => {
    expect(hablarDeChrome({ tipo: 'windows' })).toBe(true);
    expect(hablarDeChrome(undefined)).toBe(true);
  });
});


describe('procedenciaDeConsumo', () => {
  it('en vivo no necesita explicaciones', () => {
    expect(procedenciaDeConsumo({ origen: 'vivo', motivo: '', fetchedAtMs: Date.now() })).toBe('en vivo');
  });

  it('lo guardado dice de cuándo es Y por qué no es de ahora', () => {
    // Las dos mitades importan: la antigüedad para saber cuánto confiar, y el
    // motivo porque "el token venció" y "no hay red" se ven igual en pantalla
    // pero se arreglan distinto.
    const texto = procedenciaDeConsumo({
      origen: 'guardado',
      motivo: 'token-vencido',
      fetchedAtMs: Date.now() - 3 * 3600_000
    });
    expect(texto).toContain('último dato, de hace 3 horas');
    expect(texto).toContain('el token venció');
  });

  it('la caché del CLI se nombra como lo que es', () => {
    expect(
      procedenciaDeConsumo({ origen: 'cli', motivo: 'sin-respuesta', fetchedAtMs: Date.now() - 86400_000 })
    ).toBe('caché del CLI, de ayer · sin respuesta de la API (red o demora)');
  });

  it('sin fecha no se inventa una', () => {
    expect(procedenciaDeConsumo({ origen: 'cli', motivo: '', fetchedAtMs: 0 })).toBe('caché del CLI');
  });

  it('un motivo que la interfaz no conoce se muestra igual, no desaparece', () => {
    expect(textoDeMotivo('motivo-nuevo')).toBe('motivo-nuevo');
  });
});

describe('raicesMudas', () => {
  const pozo: Raiz = { configDir: 'C:/Users/x/.claude', entorno: { tipo: 'windows' }, estado: { tipo: 'ok' } };
  const wsl = (estado: Raiz['estado']): Raiz => ({
    configDir: '\\wsl.localhost\Ubuntu\home\p\.claude',
    entorno: { tipo: 'wsl', distro: 'Ubuntu', home: '/home/p' },
    estado
  });

  it('no dice nada cuando todo se pudo leer', () => {
    expect(raicesMudas([pozo, wsl({ tipo: 'ok' })])).toEqual([]);
  });

  // El caso real: WSL se apaga solo por inactividad, así que la lista se queda
  // sin las sesiones de Ubuntu y con todas las de Windows.
  it('delata la distro apagada y ofrece encenderla', () => {
    expect(raicesMudas([pozo, wsl({ tipo: 'apagada', mensaje: 'Distro apagada' })])).toEqual([
      { distro: 'Ubuntu', mensaje: 'Distro apagada', apagada: true }
    ]);
  });

  it('también delata las que no se arreglan encendiendo', () => {
    expect(raicesMudas([wsl({ tipo: 'sin-config', mensaje: 'No hay Claude Code configurado ahí' })])).toEqual([
      { distro: 'Ubuntu', mensaje: 'No hay Claude Code configurado ahí', apagada: false }
    ]);
  });

  it('el pozo de Windows nunca entra: se lee siempre', () => {
    expect(raicesMudas([pozo])).toEqual([]);
  });

  // Dos cuentas en la misma distro miran el mismo ~/.claude: el aviso es de la
  // distro, no de la cuenta, y repetirlo sería además dos `key` de React iguales.
  it('una sola vez por distro aunque haya dos raíces de la misma', () => {
    const apagada = wsl({ tipo: 'apagada', mensaje: 'Distro apagada' });
    expect(raicesMudas([apagada, apagada, pozo])).toEqual([
      { distro: 'Ubuntu', mensaje: 'Distro apagada', apagada: true }
    ]);
  });

  // El mensaje se muestra tal cual: bajarlo a minúscula escribía "el cli en
  // ubuntu" y "la distro ubuntu ya no está".
  it('no toca el texto del mensaje: adentro hay nombres propios', () => {
    expect(raicesMudas([wsl({ tipo: 'sin-cli', mensaje: 'Falta el CLI en Ubuntu' })])[0].mensaje).toBe(
      'Falta el CLI en Ubuntu'
    );
  });
});

describe('raizDeCuenta', () => {
  // Caso real: la cuenta vive en ~/.claude-monitor/<id> y la raíz es el pozo
  // ~/.claude de la distro. Por configDir no coincidían nunca.
  it('empareja por distro, aunque el configDir de la cuenta no sea el pozo', () => {
    const raiz = raizCon({ tipo: 'ok' });
    const cuenta = { tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' } as const;
    expect(raizDeCuenta([raiz], cuenta)).toBe(raiz);
  });

  it('otra distro no es su raíz, y una cuenta de Windows no tiene ninguna', () => {
    const raiz = raizCon({ tipo: 'ok' });
    expect(raizDeCuenta([raiz], { tipo: 'wsl', distro: 'Debian', home: '/home/v' })).toBeUndefined();
    expect(raizDeCuenta([raiz], { tipo: 'windows' })).toBeUndefined();
    expect(raizDeCuenta([raiz], undefined)).toBeUndefined();
  });
});

describe('agruparLinajes', () => {
  // Caso real: Desktop rebobinó una conversación y el CLI la copió a un
  // .jsonl nuevo. Dos archivos, un solo primer mensaje.
  const sesion = (id: string, linaje: string, mtime: number, extra: Partial<SessionMeta> = {}): SessionMeta => ({
    id,
    linaje,
    mtime,
    cwd: 'C:\\p',
    gitBranch: '',
    preview: 'revisa el flujo',
    projectSlug: 'C--p',
    sizeBytes: 1,
    raiz: 'C:\\Users\\v\\.claude',
    entorno: { tipo: 'windows' },
    ...extra
  });

  it('junta las copias de la misma conversación y la más reciente va de principal', () => {
    // Ordenadas por fecha, como llegan de sessions:list.
    const grupos = agruparLinajes([sesion('nueva', 'u1', 200), sesion('vieja', 'u1', 100), sesion('otra', 'u2', 50)]);
    expect(grupos.map((g) => [g.principal.id, g.otras.map((o) => o.id)])).toEqual([
      ['nueva', ['vieja']],
      ['otra', []]
    ]);
  });

  it('sin linaje no afirma nada: dos archivos sin uuid quedan separados aunque se parezcan', () => {
    const grupos = agruparLinajes([sesion('a', '', 2), sesion('b', '', 1)]);
    expect(grupos).toHaveLength(2);
  });

  it('el mismo linaje en otra raíz es otra conversación; en otra carpeta de la misma raíz, la misma', () => {
    const grupos = agruparLinajes([
      sesion('a', 'u1', 3),
      sesion('b', 'u1', 2, { raiz: '\\\\wsl.localhost\\Ubuntu\\home\\v\\.claude' }),
      // Desktop la copió a otra carpeta de proyecto, con el mismo id.
      sesion('a', 'u1', 1, { projectSlug: 'C--q' })
    ]);
    expect(grupos.map((g) => [g.principal.id, g.otras.length])).toEqual([
      ['a', 1],
      ['b', 0]
    ]);
  });
});

describe('raizUNC', () => {
  // El unico punto donde esto se puede romper es la cuenta de barras: dos al
  // principio y una separando. Con una de menos el selector abre en cualquier
  // lado y con una de mas no abre en ninguno, y las dos fallan calladas.
  it('arma la raiz de la distro con las barras que van', () => {
    expect(raizUNC('Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu');
  });

  it('un nombre con puntos y guiones pasa tal cual', () => {
    expect(raizUNC('Ubuntu-22.04')).toBe('\\\\wsl.localhost\\Ubuntu-22.04');
  });
});
