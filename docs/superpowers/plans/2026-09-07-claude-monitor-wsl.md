# Claude Monitor sobre WSL — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el monitor (Windows) liste y opere las sesiones de un Claude Code instalado en una distro de WSL de la misma máquina, sin romper nada de lo que ya funciona para Windows CLI ni para Desktop.

**Architecture:** Una instalación de WSL entra como una cuenta más (`Profile`) cuyo `configDir` es la ruta UNC `\\wsl.localhost\<distro>\<home>\.claude`, más un campo `entorno` que dice dónde vive. Todo lo que hoy asume una raíz única pasa a recorrer N raíces; todo lo que hoy asume Windows se bifurca en ese campo. El pozo de `projects/` sigue existiendo, pero sólo para cuentas Windows: se midió que no se puede extender a WSL por enlaces en ninguna de las dos direcciones.

**Tech Stack:** Electron 33 + React 18 + TypeScript 5.7, electron-vite, vitest. Windows 11 + WSL2.

**Spec:** `docs/superpowers/specs/2026-09-07-claude-monitor-wsl-design.md`

## Global Constraints

- **Idioma:** todo el código, comentarios, tests (`describe`/`it`) y textos de UI en español. Es la convención del repo, sin excepción.
- **Tests:** vitest, archivo `*.test.ts` **al lado** del fuente (`electron/wsl.ts` → `electron/wsl.test.ts`). Sólo funciones puras: no hay mocks de `child_process` ni del filesystem en este repo, y no se introducen.
- **Comando de test:** `npm test` (= `vitest run`). Para uno solo: `npx vitest run electron/wsl.test.ts`.
- **`wsl.exe` emite UTF-16LE.** Verificado: `55 00 62 00 75 00 6E 00 74 00 75 00`. Toda lectura de su stdout se decodifica como `utf16le`, nunca como utf8.
- **`wsl -l -q --running`** devuelve 0 bytes si no hay nada corriendo, y los nombres uno por línea si los hay. Verificado en ambos estados.
- **Nunca tocar la UNC de una distro apagada:** la enciende (medido: `Test-Path` devuelve True en 1,90 s y deja la distro `Running`, 345 MB de `vmmemWSL`). Toda lectura de una raíz WSL va detrás de la compuerta de `wsl -l -q --running`.
- **`--cd` y las rutas van como argumento de `wsl.exe`, nunca por la línea de un shell.** El `cwd` sale de un `.jsonl` y no es confiable.
- **No se toca `tokens.ts`** salvo que se active el plan B de §5.3 del spec, que este plan no incluye.
- **No se le agrega `timeout` al resto del proyecto.** Sólo a las llamadas nuevas de esta función (§8.4 del spec).
- **Commits:** uno por tarea, en español, con el formato `feat:` / `fix:` / `test:` que ya usa el repo (`git log --oneline`).

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `electron/wsl.ts` | **nuevo.** Todo lo específico de WSL: parseo de la salida de `wsl.exe`, armado de rutas UNC↔POSIX, argv del lanzador, máquina de estados de una raíz. Funciones puras + un par de envoltorios delgados sobre `execFile`. |
| `electron/wsl.test.ts` | **nuevo.** Tests de todo lo puro de `wsl.ts`. |
| `shared/types.ts` | `Entorno`, `Profile.entorno`, `SessionMeta.raiz` y `.entorno`, `EstadoRaiz`. |
| `electron/profiles.ts` | `raices()`, `createWslProfile()`, guard de borrado. |
| `electron/sessions.ts` | `listSessions(configDir, entorno)` etiquetando dentro de la caché. |
| `electron/shared-projects.ts` | Guard: nunca junction en una cuenta WSL. Reescribir el comentario del invariante. |
| `electron/terminal.ts` | Bifurcación del lanzador, `shQuote`, banner bash. |
| `electron/main.ts` | `sessions:list` sobre N raíces, `findSession` por raíz, IPC del alta WSL. |
| `electron/desktop.ts` | Guard: deshabilitado en cuentas WSL. |
| `src/SessionList.tsx`, `src/Sidebar.tsx` | Marca de origen, estados de raíz, botones deshabilitados con motivo. |

---

# REBANADA 1 — Lectura

Al terminar: las sesiones de WSL aparecen mezcladas y marcadas, se ve su transcript y su consumo. Reanudar, crear y borrar quedan deshabilitados **con motivo a la vista**.

---

### Task 1: `wsl.ts` — parseo de la salida de `wsl.exe`

**Files:**
- Create: `electron/wsl.ts`
- Create: `electron/wsl.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `parseDistros(stdout: string): string[]`, `configDirUNC(distro: string, home: string): string`

- [ ] **Step 1: Write the failing test**

`electron/wsl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configDirUNC, parseDistros } from './wsl';

describe('parseDistros', () => {
  it('lee la salida de wsl -l -q', () => {
    expect(parseDistros('Ubuntu\r\nDebian\r\n')).toEqual(['Ubuntu', 'Debian']);
  });

  it('aguanta los NUL de una decodificación equivocada (regresión: UTF-16LE)', () => {
    // Si alguien decodifica como utf8 lo que wsl.exe emite en utf16le, cada
    // carácter llega seguido de un \0. Medido: 55 00 62 00 75 00 6E 00 …
    expect(parseDistros('U\0b\0u\0n\0t\0u\0\r\0\n\0')).toEqual(['Ubuntu']);
  });

  it('sin nada corriendo, wsl -l -q --running devuelve vacío', () => {
    expect(parseDistros('')).toEqual([]);
    expect(parseDistros('\r\n\r\n')).toEqual([]);
  });

  it('conserva los nombres con espacios', () => {
    expect(parseDistros('Ubuntu 22.04\r\n')).toEqual(['Ubuntu 22.04']);
  });
});

describe('configDirUNC', () => {
  it('arma la ruta desde el $HOME POSIX de la distro', () => {
    expect(configDirUNC('Ubuntu', '/home/vos')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\vos\\.claude'
    );
  });

  it('el usuario de Linux no tiene por qué ser el de Windows', () => {
    expect(configDirUNC('Ubuntu', '/home/otro')).toContain('\\home\\otro\\');
  });

  it('rechaza un $HOME que no sea absoluto, en vez de armar una ruta rara', () => {
    expect(() => configDirUNC('Ubuntu', 'home/vos')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/wsl.test.ts`
Expected: FAIL — `Failed to resolve import "./wsl"`.

- [ ] **Step 3: Write minimal implementation**

`electron/wsl.ts`:

```ts
/**
 * Todo lo específico de WSL vive acá.
 *
 * La regla que ordena el módulo: lo que se puede decidir con una cadena es una
 * función pura y tiene test; lo que necesita hablar con `wsl.exe` es un
 * envoltorio delgado que llama a una de ellas. Sin esa separación, nada de esto
 * se puede probar sin una distro instalada.
 */

/**
 * Los nombres de distro que salen de `wsl -l -q` (o `wsl -l -q --running`).
 *
 * `wsl.exe` emite UTF-16LE, no UTF-8. Medido en esta máquina:
 *
 *   55 00 62 00 75 00 6E 00 74 00 75 00 0D 00 0A 00   →  "Ubuntu\r\n"
 *
 * El llamador tiene que decodificar con `utf16le`. Igual se limpian los NUL
 * acá: si alguien decodifica mal, el síntoma sería un nombre de distro con
 * NUL adentro que no matchea nada y falla de forma muda — y un fallo mudo en
 * una lista de cuentas es lo peor que puede pasar.
 *
 * Con `--running` y nada corriendo la salida es de CERO bytes, así que la
 * lista vacía es un resultado normal y no un error.
 */
export function parseDistros(stdout: string): string[] {
  return stdout
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0);
}

/**
 * La carpeta de configuración de Claude Code de una distro, vista desde
 * Windows.
 *
 * Se guarda en forma UNC y no POSIX a propósito: `credentials.ts`, `usage.ts`,
 * `onboarding.ts` y `sessions.ts` ya reciben un `configDir` y lo leen con
 * `node:fs`, y está verificado que `node:fs` lee, escribe y borra sobre
 * `\\wsl.localhost\...`. Con la UNC esos cuatro módulos no se tocan.
 *
 * El `home` viene de preguntarle a la distro (`echo $HOME`) UNA vez, al dar de
 * alta la cuenta: el usuario de Linux no tiene por qué ser el de Windows, y
 * averiguarlo en cada arranque obligaría a encender la distro sólo para eso.
 */
export function configDirUNC(distro: string, home: string): string {
  if (!home.startsWith('/')) {
    throw new Error(`El $HOME de ${distro} tiene que ser una ruta absoluta: ${home}`);
  }
  const partes = home.split('/').filter(Boolean);
  return ['\\\\wsl.localhost', distro, ...partes, '.claude'].join('\\');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/wsl.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/wsl.ts electron/wsl.test.ts
git commit -m "feat: parseo de la salida de wsl.exe y ruta UNC de una distro"
```

---

### Task 2: `wsl.ts` — estado de una raíz

**Files:**
- Modify: `electron/wsl.ts`
- Modify: `electron/wsl.test.ts`
- Modify: `shared/types.ts`

**Interfaces:**
- Consumes: `parseDistros` (Task 1).
- Produces: `type EstadoRaiz`, `estadoDeRaiz(args): EstadoRaiz`

- [ ] **Step 1: Write the failing test**

Agregar a `electron/wsl.test.ts`:

```ts
import { estadoDeRaiz } from './wsl';

describe('estadoDeRaiz', () => {
  const base = { distro: 'Ubuntu', corriendo: ['Ubuntu'], hayConfig: true, hayCli: true };

  it('todo bien', () => {
    expect(estadoDeRaiz(base)).toEqual({ tipo: 'ok' });
  });

  it('la distro ya no está instalada', () => {
    expect(estadoDeRaiz({ ...base, distro: 'Debian', instaladas: ['Ubuntu'] })).toEqual({
      tipo: 'sin-distro',
      mensaje: 'La distro Debian ya no está'
    });
  });

  it('apagada: se avisa y se ofrece encender, no se enciende sola', () => {
    expect(estadoDeRaiz({ ...base, corriendo: [] })).toEqual({
      tipo: 'apagada',
      mensaje: 'Distro apagada'
    });
  });

  it('corriendo pero sin ~/.claude', () => {
    expect(estadoDeRaiz({ ...base, hayConfig: false })).toEqual({
      tipo: 'sin-config',
      mensaje: 'No hay Claude Code configurado ahí'
    });
  });

  it('corriendo pero sin el CLI en el PATH', () => {
    expect(estadoDeRaiz({ ...base, hayCli: false })).toEqual({
      tipo: 'sin-cli',
      mensaje: 'Falta el CLI en Ubuntu'
    });
  });

  it('apagada gana sobre lo que no se pudo mirar: no se puede saber sin encenderla', () => {
    expect(estadoDeRaiz({ ...base, corriendo: [], hayConfig: false, hayCli: false }).tipo).toBe(
      'apagada'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/wsl.test.ts`
Expected: FAIL — `estadoDeRaiz is not exported`.

- [ ] **Step 3: Write minimal implementation**

En `shared/types.ts`:

```ts
/** En qué estado está la raíz de una cuenta WSL. Ninguno es silencioso: la
 *  lista vacía sin explicación es justo lo que hay que evitar. */
export type EstadoRaiz =
  | { tipo: 'ok' }
  | { tipo: 'sin-distro'; mensaje: string }
  | { tipo: 'apagada'; mensaje: string }
  | { tipo: 'sin-config'; mensaje: string }
  | { tipo: 'sin-cli'; mensaje: string };
```

En `electron/wsl.ts`:

```ts
import type { EstadoRaiz } from '../shared/types';

/**
 * En qué estado está la raíz de una cuenta WSL.
 *
 * Es pura y recibe lo ya averiguado, para poder probar la tabla entera sin una
 * distro. El orden de los casos importa: `apagada` va ANTES que `sin-config` y
 * `sin-cli` porque con la distro apagada esas dos cosas no se pueden mirar sin
 * encenderla, y encenderla de rebote es exactamente lo que no se hace.
 */
export function estadoDeRaiz(args: {
  distro: string;
  /** Lo que devolvió `wsl -l -q --running`. */
  corriendo: string[];
  /** Lo que devolvió `wsl -l -q`. Si no se pasa, no se chequea. */
  instaladas?: string[];
  hayConfig: boolean;
  hayCli: boolean;
}): EstadoRaiz {
  const { distro, corriendo, instaladas, hayConfig, hayCli } = args;

  if (instaladas && !instaladas.includes(distro)) {
    return { tipo: 'sin-distro', mensaje: `La distro ${distro} ya no está` };
  }
  if (!corriendo.includes(distro)) {
    return { tipo: 'apagada', mensaje: 'Distro apagada' };
  }
  if (!hayConfig) {
    return { tipo: 'sin-config', mensaje: 'No hay Claude Code configurado ahí' };
  }
  if (!hayCli) {
    return { tipo: 'sin-cli', mensaje: `Falta el CLI en ${distro}` };
  }
  return { tipo: 'ok' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/wsl.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/wsl.ts electron/wsl.test.ts shared/types.ts
git commit -m "feat: maquina de estados de una raiz de WSL"
```

---

### Task 3: Tipos del entorno y etiquetado de sesiones

**Files:**
- Modify: `shared/types.ts`
- Modify: `electron/sessions.ts:103` (firma de `listSessions`) y `:140-152` (armado del `SessionMeta`)
- Modify: `electron/sessions.test.ts`

**Interfaces:**
- Consumes: nada de tareas previas.
- Produces: `type Entorno`, `Profile.entorno?`, `SessionMeta.raiz`, `SessionMeta.entorno`, `listSessions(configDir: string, entorno: Entorno): Promise<SessionMeta[]>`

- [ ] **Step 1: Write the failing test**

Agregar a `electron/sessions.test.ts`:

```ts
import { WINDOWS } from './wsl';

describe('listSessions: etiqueta de origen', () => {
  it('la etiqueta queda DENTRO del objeto cacheado, no puesta después', async () => {
    // La caché de listSessions guarda el SessionMeta ya armado. Si la etiqueta
    // se agregara al salir, la segunda llamada —que devuelve el objeto
    // cacheado— vendría sin ella. Este test corre listSessions DOS veces a
    // propósito: la primera puebla la caché, la segunda la usa.
    const raiz = await raizDePrueba(); // helper existente del archivo
    const primera = await listSessions(raiz, WINDOWS);
    const segunda = await listSessions(raiz, WINDOWS);
    expect(primera[0].entorno).toEqual({ tipo: 'windows' });
    expect(primera[0].raiz).toBe(raiz);
    expect(segunda[0].entorno).toEqual({ tipo: 'windows' });
    expect(segunda[0].raiz).toBe(raiz);
  });
});
```

> Si `electron/sessions.test.ts` no tiene un helper que arme una raíz temporal, crearlo en este mismo paso con `mkdtemp` de `node:fs/promises`, escribiendo un `.jsonl` de una línea con `{"type":"user","cwd":"C:\\x","message":{"content":"hola"}}`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/sessions.test.ts`
Expected: FAIL — `listSessions` acepta 1 argumento, y `entorno`/`raiz` no existen en `SessionMeta`.

- [ ] **Step 3: Write minimal implementation**

En `shared/types.ts`:

```ts
/** Dónde vive una instalación de Claude Code.
 *
 *  Es opcional en `Profile` a propósito: su ausencia significa Windows, que es
 *  el caso de siempre, así que un `profiles.json` escrito antes de esto sigue
 *  siendo válido y no hace falta migrarlo. */
export type Entorno =
  | { tipo: 'windows' }
  | { tipo: 'wsl'; distro: string; home: string };

export type Profile = {
  id: string;
  name: string;
  configDir: string;
  isDefault: boolean;
  entorno?: Entorno;
};

export type SessionMeta = ParsedSession & {
  id: string;
  projectSlug: string;
  mtime: number;
  sizeBytes: number;
  /** La raíz que contiene este archivo. Va la RAÍZ y no un `profileId` porque
   *  por el pozo muchas cuentas Windows comparten una sola raíz: atar la
   *  sesión a una cuenta sería falso. */
  raiz: string;
  /** Dónde se reanuda. La UI la usa para la marca; el lanzador, para el shell. */
  entorno: Entorno;
};
```

En `electron/wsl.ts`:

```ts
import type { Entorno } from '../shared/types';

/** El entorno de siempre. Existe para no repetir el literal en cada llamador. */
export const WINDOWS: Entorno = { tipo: 'windows' };
```

En `electron/sessions.ts`, cambiar la firma y el armado:

```ts
export async function listSessions(configDir: string, entorno: Entorno): Promise<SessionMeta[]> {
```

y dentro del `else` que arma `meta` (hoy en `sessions.ts:140`), agregar los dos campos **antes** de que el objeto entre en `nextCache`:

```ts
          meta = {
            ...parsed,
            id: file.replace(/\.jsonl$/, ''),
            projectSlug: name,
            mtime: stats.mtimeMs,
            sizeBytes: stats.size,
            // Adentro del objeto cacheado, no puesto al salir: la caché guarda
            // este mismo objeto y la segunda llamada lo devuelve tal cual.
            raiz: configDir,
            entorno
          };
```

Actualizar el llamador de `main.ts:312` a `listSessions(await getSharedRoot(), WINDOWS)` para que compile; la N-raíces llega en la Task 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS. Toda la suite: este cambio toca un tipo compartido.

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts electron/sessions.ts electron/sessions.test.ts electron/wsl.ts electron/main.ts
git commit -m "feat: cada sesion sabe de que raiz y de que entorno salio"
```

---

### Task 4: Guards de seguridad — borrado de cuenta y pozo

Esta tarea va **antes** de que exista cualquier cuenta WSL, a propósito: es la que impide que crear una la vuelva destructiva.

**Files:**
- Modify: `electron/profiles.ts:190-207` (`deleteProfile`)
- Modify: `electron/shared-projects.ts:19` (`shareProjects`)
- Create: `electron/profiles.test.ts` (si no existe) o modificar el existente

**Interfaces:**
- Consumes: `Profile.entorno` (Task 3).
- Produces: `sePuedeBorrarDelDisco(configDir: string, profilesRoot: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { sePuedeBorrarDelDisco } from './profiles';

describe('sePuedeBorrarDelDisco', () => {
  const raiz = 'C:\\Users\\x\\AppData\\Roaming\\claude-monitor\\profiles';

  it('sí: la carpeta la creó la app', () => {
    expect(sePuedeBorrarDelDisco(`${raiz}\\a1b2c3d4`, raiz)).toBe(true);
  });

  it('NO: el ~/.claude real del usuario', () => {
    expect(sePuedeBorrarDelDisco('C:\\Users\\x\\.claude', raiz)).toBe(false);
  });

  it('NO: la instalación de Claude Code adentro de WSL', () => {
    // Este es el caso que destruye datos: configDir de una cuenta WSL apunta a
    // la instalación real de esa persona en Ubuntu, y el borrado por UNC
    // funciona. Verificado en la máquina de desarrollo.
    expect(sePuedeBorrarDelDisco('\\\\wsl.localhost\\Ubuntu\\home\\vos\\.claude', raiz)).toBe(
      false
    );
  });

  it('NO: un hermano cuyo nombre empieza igual', () => {
    expect(sePuedeBorrarDelDisco(`${raiz}-viejo\\a1`, raiz)).toBe(false);
  });

  it('NO: la raíz misma', () => {
    expect(sePuedeBorrarDelDisco(raiz, raiz)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/profiles.test.ts`
Expected: FAIL — `sePuedeBorrarDelDisco is not exported`.

- [ ] **Step 3: Write minimal implementation**

En `electron/profiles.ts`:

```ts
import { relative, isAbsolute } from 'node:path';

/**
 * Si es legítimo hacer `rm -rf` de este `configDir`.
 *
 * La regla es de propiedad, no de contenido: la app sólo borra del disco lo que
 * ella misma creó, que es todo lo que cuelga de `profilesRoot()`
 * (ver `createProfile`, que arma el configDir con `join(profilesRoot(), id)`).
 *
 * Cualquier otra cosa es una carpeta ADOPTADA y se da de baja del registro sin
 * tocar el disco. Los dos casos que esto protege:
 *
 *   - El `~/.claude` real del usuario, que el guard viejo cubría por `isDefault`
 *     — un campo que sale de un archivo editable.
 *   - El `configDir` de una cuenta WSL, que apunta a la instalación real de
 *     Claude Code adentro de la distro: credenciales, historial y ajustes de
 *     esa persona. El borrado por UNC funciona, así que sin este guard el
 *     "eliminar cuenta" del panel se la llevaba puesta.
 */
export function sePuedeBorrarDelDisco(configDir: string, raizDePerfiles: string): boolean {
  const rel = relative(raizDePerfiles, configDir);
  // Vacío = es la raíz misma. '..' al principio = está afuera. Absoluto = otro
  // volumen o una UNC, que nunca cuelga de la raíz.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
```

y en `deleteProfile`, reemplazar el bloque de borrado:

```ts
  // Antes esto era un `rm` incondicional. Ver `sePuedeBorrarDelDisco`.
  if (sePuedeBorrarDelDisco(profile.configDir, profilesRoot())) {
    await unlinkShared(profile.configDir);
    await rm(profile.configDir, { recursive: true, force: true });
  }
  registry.profiles = registry.profiles.filter((p) => p.id !== id);
```

En `electron/shared-projects.ts`, al principio de `shareProjects`:

```ts
export async function shareProjects(
  configDir: string,
  sharedRoot: string,
  entorno: Entorno = { tipo: 'windows' }
): Promise<void> {
  // Una cuenta WSL nunca entra al pozo. Medido: no se puede crear un junction
  // de Windows adentro de ext4 ("Función incorrecta"), y un symlink de Linux
  // hacia /mnt/c lo lee WSL pero NO lo lee Windows por la UNC (1 entrada de
  // 31). Intentarlo sólo deja basura.
  if (entorno.tipo === 'wsl') return;
  if (configDir === sharedRoot) return;
```

y reescribir el encabezado del módulo, que hoy promete de más:

```
 * Hace que todas las cuentas DE WINDOWS vean las mismas conversaciones.
 ...
 * Las cuentas de WSL quedan afuera: su `projects` vive en ext4 y no hay forma
 * de enlazarlo que Windows sepa leer. Ver el spec de WSL, §2.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/profiles.ts electron/profiles.test.ts electron/shared-projects.ts
git commit -m "fix: la app solo borra del disco los configDir que ella creo"
```

---

### Task 5: `raices()` y alta de una cuenta WSL

**Files:**
- Modify: `electron/wsl.ts`
- Modify: `electron/wsl.test.ts`
- Modify: `electron/profiles.ts`

**Interfaces:**
- Consumes: `parseDistros`, `configDirUNC`, `estadoDeRaiz`, `EstadoRaiz`, `Entorno`.
- Produces: `distrosInstaladas(): Promise<string[]>`, `distrosCorriendo(): Promise<string[]>`, `homeDe(distro: string): Promise<string>`, `hayCliEn(distro: string): Promise<boolean>`, `raices(): Promise<Raiz[]>` con `type Raiz = { configDir: string; entorno: Entorno; estado: EstadoRaiz }`, `createWslProfile(name: string, distro: string): Promise<Profile>`

- [ ] **Step 1: Write the failing test**

Agregar a `electron/wsl.test.ts`:

```ts
import { TIMEOUT_WSL, argsDeConsulta } from './wsl';

describe('llamadas a wsl.exe', () => {
  it('toda consulta lleva timeout: una distro enferma no puede congelar el panel', () => {
    // Corre en el proceso main. Medido: tocar la UNC de una distro apagada
    // tarda 1,90 s; una distro enferma puede no volver nunca.
    expect(TIMEOUT_WSL).toBeGreaterThan(0);
    expect(TIMEOUT_WSL).toBeLessThanOrEqual(10000);
  });

  it('la consulta de lo que corre no enciende nada', () => {
    // `wsl -l -q --running` es la única forma barata de preguntar sin efecto.
    // Verificado: 0,12 s, y la distro sigue apagada después.
    expect(argsDeConsulta('corriendo')).toEqual(['-l', '-q', '--running']);
    expect(argsDeConsulta('instaladas')).toEqual(['-l', '-q']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/wsl.test.ts`
Expected: FAIL — `TIMEOUT_WSL is not exported`.

- [ ] **Step 3: Write minimal implementation**

En `electron/wsl.ts`:

```ts
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Techo para toda llamada a `wsl.exe`.
 *
 * Esto corre en el proceso main: una llamada que no vuelve congela el panel.
 * Medido: tocar la UNC de una distro apagada tarda 1,90 s, y una distro
 * enferma puede colgar indefinidamente. El resto del proyecto no tiene
 * timeouts y no se los agrega acá: es otro trabajo.
 */
export const TIMEOUT_WSL = 8000;

export function argsDeConsulta(que: 'instaladas' | 'corriendo'): string[] {
  return que === 'corriendo' ? ['-l', '-q', '--running'] : ['-l', '-q'];
}

/** `wsl.exe` emite UTF-16LE. Con 'buffer' se decodifica acá y no se depende de
 *  la codificación por defecto del proceso. */
async function consultar(que: 'instaladas' | 'corriendo'): Promise<string[]> {
  const { stdout } = await run('wsl.exe', argsDeConsulta(que), {
    encoding: 'buffer',
    timeout: TIMEOUT_WSL,
    windowsHide: true
  }).catch(() => ({ stdout: Buffer.alloc(0) }));
  return parseDistros(Buffer.from(stdout).toString('utf16le'));
}

export const distrosInstaladas = (): Promise<string[]> => consultar('instaladas');
export const distrosCorriendo = (): Promise<string[]> => consultar('corriendo');

/** El `$HOME` de la distro. Se pregunta UNA vez, al dar de alta, y se persiste
 *  en `Entorno.home`: averiguarlo en cada arranque obligaría a encender la
 *  distro sólo para saber una ruta. */
export async function homeDe(distro: string): Promise<string> {
  const { stdout } = await run('wsl.exe', ['-d', distro, '--', 'bash', '-lc', 'echo $HOME'], {
    encoding: 'utf8',
    timeout: TIMEOUT_WSL,
    windowsHide: true
  });
  const home = stdout.replace(/\0/g, '').trim();
  if (!home.startsWith('/')) throw new Error(`No se pudo leer el $HOME de ${distro}`);
  return home;
}

/** Si `claude` está en el PATH de login de la distro. `-l` porque nvm y
 *  compañía viven en el perfil de login. */
export async function hayCliEn(distro: string): Promise<boolean> {
  return run('wsl.exe', ['-d', distro, '--', 'bash', '-lc', 'command -v claude'], {
    encoding: 'utf8',
    timeout: TIMEOUT_WSL,
    windowsHide: true
  })
    .then(({ stdout }) => stdout.trim().length > 0)
    .catch(() => false);
}
```

En `shared/types.ts` (y **no** en `profiles.ts`: `sessions:list` devuelve estas
raíces por IPC y el renderer las tipa desde acá):

```ts
/** Una raíz de lectura y en qué estado está. Viaja por IPC: la UI necesita
 *  poder decir "distro apagada" en vez de mostrar una lista corta y muda. */
export type Raiz = { configDir: string; entorno: Entorno; estado: EstadoRaiz };
```

En `electron/profiles.ts`:

```ts
/**
 * Todas las raíces que hay que leer: el pozo de Windows más una por cada
 * cuenta WSL.
 *
 * La compuerta es `wsl -l -q --running` y NO es una optimización: tocar la UNC
 * de una distro apagada la enciende (medido: True en 1,90 s, la distro queda
 * Running, 345 MB de vmmemWSL). Como el panel refresca la lista, sondear a
 * ciegas dejaría la VM prendida para siempre — el monitor sería la causa del
 * problema de memoria que ayuda a observar.
 */
export async function raices(): Promise<Raiz[]> {
  const registry = await loadRegistry();
  const salida: Raiz[] = [
    { configDir: await getSharedRoot(), entorno: WINDOWS, estado: { tipo: 'ok' } }
  ];

  const wsl = registry.profiles.filter(
    (p): p is Profile & { entorno: Extract<Entorno, { tipo: 'wsl' }> } => p.entorno?.tipo === 'wsl'
  );
  if (wsl.length === 0) return salida;

  const [instaladas, corriendo] = await Promise.all([distrosInstaladas(), distrosCorriendo()]);

  for (const p of wsl) {
    const { distro } = p.entorno;
    // Sólo se mira el disco si la distro YA está corriendo. Si no, ni se toca.
    const arranca = corriendo.includes(distro) && instaladas.includes(distro);
    const hayConfig = arranca ? Boolean(await stat(p.configDir).catch(() => null)) : false;
    const hayCli = arranca ? await hayCliEn(distro) : false;
    salida.push({
      configDir: p.configDir,
      entorno: p.entorno,
      estado: estadoDeRaiz({ distro, corriendo, instaladas, hayConfig, hayCli })
    });
  }
  return salida;
}

/** Da de alta una cuenta que vive en una distro. El `configDir` es ADOPTADO:
 *  no se crea nada en disco, y por eso `sePuedeBorrarDelDisco` lo protege. */
export async function createWslProfile(name: string, distro: string): Promise<Profile> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('El nombre de la cuenta no puede estar vacío');
  if (!(await distrosInstaladas()).includes(distro)) {
    throw new Error(`La distro ${distro} no está instalada`);
  }
  if (!(await hayCliEn(distro))) {
    throw new Error(`En ${distro} no hay \`claude\` instalado. Instalalo ahí y volvé a intentar.`);
  }
  const home = await homeDe(distro);
  const registry = await loadRegistry();
  const id = randomUUID().slice(0, 8);
  const profile: Profile = {
    id,
    name: trimmed,
    configDir: configDirUNC(distro, home),
    isDefault: false,
    entorno: { tipo: 'wsl', distro, home }
  };
  // Ni mkdir, ni shareProjects, ni syncPlugins, ni ensureHostScript: la carpeta
  // ya existe y es del usuario, el pozo no la admite, y Chrome es de Windows.
  registry.profiles.push(profile);
  await saveRegistry(registry);
  return profile;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/wsl.ts electron/wsl.test.ts electron/profiles.ts
git commit -m "feat: raices de lectura y alta de cuenta WSL, sin encender distros"
```

---

### Task 6: `sessions:list` sobre N raíces

**Files:**
- Modify: `electron/main.ts:52` (`findSession`), `:312` (`sessions:list`), `:346` (`sessions:transcript`), `:354` (`sessions:tokens`), `:361` (`sessions:delete`)
- Modify: `electron/preload.ts`, `shared/types.ts` (API del alta WSL y de las raíces)

**Interfaces:**
- Consumes: `raices()`, `listSessions(configDir, entorno)`, `createWslProfile`.
- Produces: `sessions:list` devuelve `{ sesiones: SessionMeta[]; raices: Raiz[] }`; `findSession(id)` devuelve `{ session: SessionMeta }` y la ruta se arma con `session.raiz`.

- [ ] **Step 1: Write the failing test**

Agregar a `electron/sessions.test.ts`:

```ts
import { mezclarRaices } from './sessions';

describe('mezclarRaices', () => {
  const w = { tipo: 'windows' } as const;
  const u = { tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' } as const;

  it('intercala por fecha, sin importar de qué raíz salió cada una', () => {
    const a = [{ id: 'a', mtime: 100, raiz: 'C:\\p', entorno: w }] as any;
    const b = [{ id: 'b', mtime: 200, raiz: '\\\\wsl.localhost\\Ubuntu', entorno: u }] as any;
    expect(mezclarRaices([a, b]).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('una raíz vacía no rompe la mezcla', () => {
    const a = [{ id: 'a', mtime: 100, raiz: 'C:\\p', entorno: w }] as any;
    expect(mezclarRaices([a, []]).map((s) => s.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/sessions.test.ts`
Expected: FAIL — `mezclarRaices is not exported`.

- [ ] **Step 3: Write minimal implementation**

En `electron/sessions.ts`:

```ts
/** Une lo que devolvió cada raíz en una sola lista por fecha. Va aparte de
 *  `listSessions` para poder probar el orden sin tocar disco. */
export function mezclarRaices(porRaiz: SessionMeta[][]): SessionMeta[] {
  return porRaiz.flat().sort((a, b) => b.mtime - a.mtime);
}
```

En `electron/main.ts`, reemplazar `findSession` y `sessions:list`:

```ts
async function findSession(id: string) {
  for (const raiz of await raices()) {
    if (raiz.estado.tipo !== 'ok') continue;
    const session = (await listSessions(raiz.configDir, raiz.entorno)).find((s) => s.id === id);
    if (session) return { session };
  }
  throw new Error(`Sesión no encontrada: ${id}`);
}

/** La ruta del transcript de una sesión, desde la raíz que la contiene. Antes
 *  se armaba con `sharedRoot`, que asumía una sola. */
const rutaDe = (s: SessionMeta) => join(s.raiz, 'projects', s.projectSlug, `${s.id}.jsonl`);

/**
 * Lee una raíz y, si vino vacía, confirma que sea por falta de sesiones y no
 * porque la distro se apagó en el medio.
 *
 * La carrera es real, no hipotética: se observó a la distro encenderse al
 * tocar la UNC y apagarse sola por inactividad antes del chequeo siguiente. Si
 * eso pasa entre `raices()` y la lectura, `listSessions` come el error de
 * `readdir` y devuelve `[]` — y las sesiones desaparecerían sin explicación,
 * que es justo lo prohibido. La reconsulta cuesta 0,12 s y sólo ocurre en el
 * caso de cero sesiones.
 */
async function leerRaiz(r: Raiz): Promise<{ sesiones: SessionMeta[]; raiz: Raiz }> {
  if (r.estado.tipo !== 'ok') return { sesiones: [], raiz: r };
  const sesiones = await listSessions(r.configDir, r.entorno);
  if (sesiones.length > 0 || r.entorno.tipo !== 'wsl') return { sesiones, raiz: r };
  const corriendo = await distrosCorriendo();
  if (corriendo.includes(r.entorno.distro)) return { sesiones, raiz: r };
  return { sesiones: [], raiz: { ...r, estado: { tipo: 'apagada', mensaje: 'Distro apagada' } } };
}

handle('sessions:list', async () => {
  const leidas = await Promise.all((await raices()).map(leerRaiz));
  // Las raíces viajan con las sesiones: la UI necesita poder decir "distro
  // apagada" en vez de mostrar una lista corta sin explicación.
  return {
    sesiones: mezclarRaices(leidas.map((l) => l.sesiones)),
    raices: leidas.map((l) => l.raiz)
  };
});
```

y usar `rutaDe(session)` en `sessions:transcript`, `sessions:resume` (para `countCompactions`) y `sessions:delete`. Para `sessions:tokens`:

```ts
handle('sessions:tokens', async () => {
  const leidas = await Promise.all((await raices()).map(leerRaiz));
  const sesiones = mezclarRaices(leidas.map((l) => l.sesiones));
  return tokensFor(sesiones.map((s) => ({ id: s.id, path: rutaDe(s) })));
});
```

Agregar el IPC del alta en `main.ts`, `preload.ts` y `shared/types.ts`:

```ts
handle('profiles:listarDistros', async () => distrosInstaladas());
handle('profiles:createWsl', (name: string, distro: string) => createWslProfile(name, distro));
handle('wsl:encender', async (distro: string) => {
  // Sólo acá se enciende una distro, y sólo porque el usuario apretó el botón.
  await run('wsl.exe', ['-d', distro, '--', 'true'], { timeout: TIMEOUT_WSL, windowsHide: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: PASS, sin errores de tipos, y los tres bundles emitidos.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/sessions.ts electron/sessions.test.ts electron/preload.ts shared/types.ts
git commit -m "feat: la lista de sesiones sale de N raices, no de una sola"
```

---

### Task 7: UI — origen, estados y botones deshabilitados con motivo

**Files:**
- Modify: `src/App.tsx` (consumir la forma nueva de `sessions:list`)
- Modify: `src/SessionList.tsx` (marca de origen; deshabilitar acciones)
- Modify: `src/Sidebar.tsx` (alta de cuenta WSL, estado de la raíz, botón "Encender")

**Interfaces:**
- Consumes: `sessions:list` → `{ sesiones, raices }`, `profiles:listarDistros`, `profiles:createWsl`, `wsl:encender`.
- Produces: nada para tareas posteriores.

- [ ] **Step 1: Write the failing test**

Los componentes de este repo no tienen tests (no hay testing-library instalado y este plan no la agrega). La verificación de esta tarea es manual y va en el Step 4. Extraer la única lógica pura a `src/format.ts`, que **sí** tiene tests:

```ts
// src/format.test.ts
import { describe, expect, it } from 'vitest';
import { etiquetaDeEntorno, motivoDeshabilitado } from './format';

describe('etiquetaDeEntorno', () => {
  it('las de Windows no llevan marca: son la mayoría y la marca sería ruido', () => {
    expect(etiquetaDeEntorno({ tipo: 'windows' })).toBe('');
  });
  it('las de WSL llevan la distro', () => {
    expect(etiquetaDeEntorno({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' })).toBe('Ubuntu');
  });
});

describe('motivoDeshabilitado', () => {
  it('explica por qué no se puede, en vez de un botón muerto', () => {
    expect(motivoDeshabilitado({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' })).toBe(
      'Se reanuda desde Ubuntu'
    );
  });
  it('en Windows no hay motivo: el botón anda', () => {
    expect(motivoDeshabilitado({ tipo: 'windows' })).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/format.test.ts`
Expected: FAIL — las dos funciones no existen.

- [ ] **Step 3: Write minimal implementation**

En `src/format.ts`:

```ts
import type { Entorno } from '../shared/types';

/** La marca de origen de una sesión. Vacía en Windows a propósito: son la
 *  mayoría, y marcarlas todas convierte la marca en ruido. */
export const etiquetaDeEntorno = (e: Entorno): string => (e.tipo === 'wsl' ? e.distro : '');

/** Por qué no se puede reanudar/crear desde el panel. Un botón deshabilitado
 *  sin motivo se lee como un bug; con motivo, como una frontera. */
export const motivoDeshabilitado = (e: Entorno): string =>
  e.tipo === 'wsl' ? `Se reanuda desde ${e.distro}` : '';
```

En `SessionList.tsx`, junto al nombre del proyecto de cada fila:

```tsx
{etiquetaDeEntorno(s.entorno) && (
  <span className="chip-entorno" title={`Sesión de ${etiquetaDeEntorno(s.entorno)}`}>
    {etiquetaDeEntorno(s.entorno)}
  </span>
)}
```

y en cada acción de esa fila (reanudar, crear, borrar — las tres, por §9 del spec):

```tsx
<button
  disabled={s.entorno.tipo === 'wsl'}
  title={motivoDeshabilitado(s.entorno)}
  onClick={() => reanudar(s.id)}
>
  Reanudar
</button>
```

En `src/index.css`, el chip reusa los tokens que ya usa el resto de la lista
(no inventar colores nuevos):

```css
.chip-entorno {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid currentColor;
  opacity: 0.7;
}
```

En `Sidebar.tsx`: botón "Agregar cuenta de WSL" que llama a `profiles:listarDistros` y ofrece elegir; y por cada cuenta WSL, cuando `estado.tipo !== 'ok'`:

```tsx
<div className="estado-raiz">
  <span>{raiz.estado.mensaje}</span>
  {raiz.estado.tipo === 'apagada' && (
    <button onClick={() => api.encenderDistro(distro)}>Encender</button>
  )}
</div>
```

El botón "Encender" es el **único** lugar de toda la app que arranca una distro, y sólo porque el usuario lo apretó.

En `desktop.ts`, al principio de `openDesktopForProfile`:

```ts
  // Desktop es una app de Windows y su pestaña Code corre el binario Windows:
  // no puede hospedar una sesión de la distro. Ver el spec de WSL, §7.
  if (profile.entorno?.tipo === 'wsl') {
    throw new Error(`Claude Desktop no puede abrir la cuenta de ${profile.entorno.distro}.`);
  }
```

- [ ] **Step 4: Verificación manual**

Run: `npm run dev`

Comprobar, en orden:
1. Sin ninguna cuenta WSL dada de alta, la lista se ve **exactamente** como antes.
2. "Agregar cuenta de WSL" lista `Ubuntu`.
3. Con la distro apagada, la cuenta muestra "Distro apagada" y un botón "Encender". **Verificar con `wsl -l -v` que sigue apagada mientras el panel está abierto** — si se enciende sola, la compuerta de la Task 5 está mal y hay que volver ahí.
4. Tras "Encender", aparecen las sesiones de WSL con el chip `Ubuntu`.
5. Reanudar/crear/borrar sobre una sesión WSL: deshabilitados, con el motivo en el tooltip.
6. El botón Desktop en la cuenta WSL da el mensaje de §7.

- [ ] **Step 5: Commit**

```bash
git add src/ electron/desktop.ts
git commit -m "feat: origen de cada sesion, estado de la distro y fronteras visibles"
```

---

### Task 8: Banco de integración sin instalar el CLI

**Files:**
- Create: `docs/superpowers/plans/banco-wsl.md` (el procedimiento, para poder repetirlo)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: evidencia de que la lectura por UNC funciona de punta a punta.

- [ ] **Step 1: Armar un `~/.claude` falso en la distro**

```bash
wsl -d Ubuntu -- bash -lc 'mkdir -p ~/.claude/projects/banco-de-prueba'
wsl -d Ubuntu -- bash -lc 'cp /mnt/c/Users/$USER/.claude/projects/*/*.jsonl ~/.claude/projects/banco-de-prueba/ 2>/dev/null; ls ~/.claude/projects/banco-de-prueba | wc -l'
```

Verificado que este truco funciona: es el mismo `cp` con el que se midió la penalización de 16x.

- [ ] **Step 2: Dar de alta la cuenta y verificar la lectura**

Con `npm run dev`: agregar la cuenta WSL, y comprobar que aparecen las sesiones del banco, que se abre el transcript de una, y que el consumo se calcula.

- [ ] **Step 3: Medir la primera corrida de `tokensFor`**

Cronometrar cuánto tarda la columna de consumo en poblarse la **primera** vez (caché fría) y la segunda. Anotar los dos números en `banco-wsl.md`.

**Criterio:** si la primera pasa de ~10 s con un volumen realista, activar el plan B de §5.3 del spec (paralelismo acotado por raíz) como tarea aparte. Si no, dejarlo como está — construirlo antes de tener el número sería adivinar.

- [ ] **Step 4: Limpiar**

```bash
wsl -d Ubuntu -- bash -lc 'rm -rf ~/.claude/projects/banco-de-prueba'
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/banco-wsl.md
git commit -m "docs: banco de pruebas de WSL y numeros de la primera corrida"
```

---

# REBANADA 2 — El lanzador

Al terminar: reanudar y crear sesiones en WSL desde el panel.

---

### Task 9: Traducción de rutas

**Files:**
- Modify: `electron/wsl.ts`, `electron/wsl.test.ts`

**Interfaces:**
- Produces: `posixAWindows(distro: string, p: string): string`, `windowsAPosix(distro: string, p: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { posixAWindows, windowsAPosix } from './wsl';

describe('posixAWindows', () => {
  it('el home de la distro va por la UNC', () => {
    expect(posixAWindows('Ubuntu', '/home/vos/proy')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\vos\\proy'
    );
  });

  it('/mnt/c va a C:\\ directo, no por la UNC: es la misma carpeta y es 16x más rápido', () => {
    expect(posixAWindows('Ubuntu', '/mnt/c/Users/x/proy')).toBe('C:\\Users\\x\\proy');
    expect(posixAWindows('Ubuntu', '/mnt/d/datos')).toBe('D:\\datos');
  });
});

describe('windowsAPosix', () => {
  it('inversa de la UNC', () => {
    expect(windowsAPosix('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\vos\\proy')).toBe(
      '/home/vos/proy'
    );
  });

  it('una carpeta de Windows elegida en el diálogo se ve desde la distro por /mnt', () => {
    expect(windowsAPosix('Ubuntu', 'C:\\Users\\x\\proy')).toBe('/mnt/c/Users/x/proy');
  });

  it('ida y vuelta', () => {
    const p = '/home/vos/un proyecto';
    expect(windowsAPosix('Ubuntu', posixAWindows('Ubuntu', p))).toBe(p);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/wsl.test.ts`
Expected: FAIL — no exportadas.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Una ruta de la distro, vista desde Windows.
 *
 * `/mnt/<letra>/...` se mapea al volumen de Windows directo y NO por la UNC: es
 * literalmente la misma carpeta, y por NTFS se lee 16x más rápido (medido:
 * 0,06 s contra 0,94 s sobre los mismos 16,8 MB).
 *
 * Son funciones puras en vez de `wslpath` para no gastar un proceso —y una
 * distro encendida— cada vez que se muestra una fila de la lista.
 */
export function posixAWindows(distro: string, p: string): string {
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (mnt) {
    const resto = (mnt[2] ?? '').split('/').filter(Boolean);
    return [`${mnt[1].toUpperCase()}:`, ...resto].join('\\') || `${mnt[1].toUpperCase()}:\\`;
  }
  return ['\\\\wsl.localhost', distro, ...p.split('/').filter(Boolean)].join('\\');
}

/** La inversa. No es decorativa: `sessions:new` abre el diálogo de carpeta de
 *  Windows, que devuelve una ruta Windows, y hay que volverla POSIX antes de
 *  pasarla a `--cd`. */
export function windowsAPosix(distro: string, p: string): string {
  const unc = new RegExp(`^\\\\\\\\wsl\\.localhost\\\\${distro}\\\\(.*)$`, 'i').exec(p);
  if (unc) return '/' + unc[1].split('\\').filter(Boolean).join('/');
  const disco = /^([a-zA-Z]):\\?(.*)$/.exec(p);
  if (disco) {
    const resto = disco[2].split('\\').filter(Boolean);
    return ['/mnt', disco[1].toLowerCase(), ...resto].join('/');
  }
  throw new Error(`No sé traducir esta ruta a POSIX: ${p}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/wsl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/wsl.ts electron/wsl.test.ts
git commit -m "feat: traduccion de rutas entre la distro y Windows"
```

---

### Task 10: `shQuote` y banner bash

**Files:**
- Modify: `electron/terminal.ts`, `electron/terminal.test.ts`

**Interfaces:**
- Produces: `shQuote(v: string): string`, `bannerBash(command: string, label: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { bannerBash, shQuote } from './terminal';

describe('shQuote', () => {
  it("cierra, escapa y reabre: es la unica forma de meter ' en comillas simples", () => {
    expect(shQuote("cuenta d'algo")).toBe("'cuenta d'\\''algo'");
  });
  it('el resto queda literal, que es el punto de la comilla simple', () => {
    expect(shQuote('$HOME `id` "x"')).toBe('\'$HOME `id` "x"\'');
  });
});

describe('bannerBash', () => {
  it('dice con qué cuenta se entra, igual que el de PowerShell', () => {
    expect(bannerBash('claude', 'Cuenta A')).toContain('Cuenta A');
    expect(bannerBash('claude', 'Cuenta A')).toContain('claude');
  });
  it('sin etiqueta, el comando va solo', () => {
    expect(bannerBash('claude', '')).toBe('claude');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/terminal.test.ts`
Expected: FAIL — no exportadas.

- [ ] **Step 3: Write minimal implementation**

```ts
/** Comilla simple de POSIX: adentro no se expande nada, y lo único que no se
 *  puede escapar es la comilla misma — hay que cerrar, escaparla y reabrir.
 *  Hermano de `psQuote`, y por la misma razón: el nombre de la cuenta lo
 *  escribe el usuario y termina en la línea de comandos de un shell. */
export function shQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** El mismo cartel que `bannerCommand`, del lado Linux: `Write-Host` adentro
 *  de Ubuntu no es nada. */
export function bannerBash(command: string, label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  if (!clean) return command;
  return [`printf '\\n  Cuenta: %s\\n\\n' ${shQuote(clean)}`, command].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/terminal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/terminal.ts electron/terminal.test.ts
git commit -m "feat: comillas y banner del lado bash"
```

---

### Task 11: Bifurcación del lanzador

**Files:**
- Modify: `electron/wsl.ts`, `electron/wsl.test.ts`, `electron/terminal.ts`

**Interfaces:**
- Consumes: `shQuote`, `bannerBash`, `windowsAPosix`.
- Produces: `argsDeLanzamiento(distro, cwdPosix, configDirPosix, command, label): string[]`; `openTerminal(cwd, command, configDir, label, entorno)`

- [ ] **Step 1: Write the failing test**

```ts
import { argsDeLanzamiento } from './wsl';

describe('argsDeLanzamiento', () => {
  const args = argsDeLanzamiento('Ubuntu', '/home/vos/proy', '/home/vos/.claude', 'claude', 'A');

  it('el cwd va como argumento de wsl.exe, nunca por la linea del shell', () => {
    // El cwd sale de un .jsonl y no es confiable.
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--cd', '/home/vos/proy']);
  });

  it('bash -lc: hace falta el perfil de login para que claude este en el PATH', () => {
    expect(args).toContain('-lc');
    expect(args[args.indexOf('-lc') - 1]).toBe('bash');
  });

  it('CLAUDE_CONFIG_DIR va por export adentro, no por WSLENV', () => {
    // WSLENV es una variable global del proceso y habria que componerla sin
    // pisar lo que el usuario tenga. El export no tiene ese problema.
    const script = args[args.length - 1];
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/home/vos/.claude'");
    expect(args.join(' ')).not.toContain('WSLENV');
  });

  it('la ruta del config va en POSIX, no en UNC', () => {
    expect(args[args.length - 1]).not.toContain('wsl.localhost');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/wsl.test.ts`
Expected: FAIL — `argsDeLanzamiento is not exported`.

- [ ] **Step 3: Write minimal implementation**

En `electron/wsl.ts`:

```ts
import { bannerBash, shQuote } from './terminal';

/**
 * El argv de `wsl.exe` para abrir una sesión adentro de la distro.
 *
 * Dos decisiones que valen la pena:
 *
 *   - El `--cd` va como ARGUMENTO, no por la línea del shell. El `cwd` sale de
 *     un `.jsonl` y no es confiable; así nunca lo parsea un shell.
 *   - `CLAUDE_CONFIG_DIR` va por `export` adentro del script y no por `WSLENV`.
 *     `WSLENV` funciona (medido) pero es una variable GLOBAL del proceso que
 *     habría que componer sin pisar lo que el usuario ya tenga: un merge frágil
 *     por una ganancia nula.
 *
 * `bash -lc` y no `bash -c`: el PATH con `claude` adentro suele venir del
 * perfil de login (nvm y compañía).
 */
export function argsDeLanzamiento(
  distro: string,
  cwdPosix: string,
  configDirPosix: string,
  command: string,
  label: string
): string[] {
  const script = [`export CLAUDE_CONFIG_DIR=${shQuote(configDirPosix)}`, bannerBash(command, label)].join(
    '\n'
  );
  return ['-d', distro, '--cd', cwdPosix, '--', 'bash', '-lc', script];
}
```

En `electron/terminal.ts`, `openTerminal` recibe el entorno y se bifurca. **El camino de Windows queda idéntico**:

```ts
export async function openTerminal(
  cwd: string,
  command: string,
  configDir: string,
  label = '',
  entorno: Entorno = { tipo: 'windows' }
): Promise<void> {
  if (entorno.tipo === 'wsl') return abrirEnWsl(cwd, command, configDir, label, entorno);
  // …de acá para abajo, exactamente lo de hoy, sin tocar…
}

/** El `stat` de acá va contra la traducción a Windows: el `cwd` de un
 *  transcript de WSL es POSIX y `stat('/home/vos/x')` en Windows siempre falla,
 *  que es el bug que hoy dice "la carpeta ya no existe". */
async function abrirEnWsl(
  cwd: string,
  command: string,
  configDir: string,
  label: string,
  entorno: Extract<Entorno, { tipo: 'wsl' }>
): Promise<void> {
  const { distro, home } = entorno;
  const cwdPosix = cwd.startsWith('/') ? cwd : windowsAPosix(distro, cwd);
  const dir = await stat(posixAWindows(distro, cwdPosix)).catch(() => null);
  if (!dir?.isDirectory()) {
    throw new Error(`No se puede abrir la terminal: la carpeta ya no existe (${cwdPosix}).`);
  }
  const args = argsDeLanzamiento(distro, cwdPosix, `${home}/.claude`, command, label);
  const options: SpawnOptions = { env: sessionEnv(process.env, configDir), detached: true, stdio: 'ignore' };
  const title = tabTitle(label);
  try {
    await launch('wt.exe', [...(title ? ['--title', title] : []), 'wsl.exe', ...args], options);
    return;
  } catch {
    await launch('wsl.exe', args, options);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS. **Los tests existentes de `terminal.test.ts` son la no-regresión de Windows: si alguno se rompe, la bifurcación tocó el camino que no debía.**

- [ ] **Step 5: Commit**

```bash
git add electron/wsl.ts electron/wsl.test.ts electron/terminal.ts
git commit -m "feat: lanzar sesiones adentro de la distro"
```

---

### Task 12: Reanudar y crear en WSL

**Files:**
- Modify: `electron/main.ts:315` (`sessions:resume`), `:328` (`sessions:new`)

**Interfaces:**
- Consumes: `openTerminal(..., entorno)`, `windowsAPosix`.
- Produces: nada.

- [ ] **Step 1: Write the failing test**

La lógica pura acá es elegir con qué cuenta se abre una sesión de WSL. Agregar a `electron/wsl.test.ts`:

```ts
import { cuentaParaSesion } from './wsl';

describe('cuentaParaSesion', () => {
  const cuentas = [
    { id: 'w1', entorno: { tipo: 'windows' } },
    { id: 'u1', entorno: { tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' } }
  ] as any;

  it('una sesión de WSL se abre con la cuenta de esa distro, no con la activa', () => {
    const s = { entorno: { tipo: 'wsl', distro: 'Ubuntu', home: '/home/vos' } } as any;
    expect(cuentaParaSesion(s, cuentas, 'w1')?.id).toBe('u1');
  });

  it('una sesión de Windows se abre con la cuenta activa, como hoy', () => {
    const s = { entorno: { tipo: 'windows' } } as any;
    expect(cuentaParaSesion(s, cuentas, 'w1')?.id).toBe('w1');
  });

  it('si la cuenta de esa distro ya no está, no se inventa otra', () => {
    const s = { entorno: { tipo: 'wsl', distro: 'Debian', home: '/home/v' } } as any;
    expect(cuentaParaSesion(s, cuentas, 'w1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/wsl.test.ts`
Expected: FAIL — no exportada.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Con qué cuenta se abre una sesión.
 *
 * Para Windows es la activa, como siempre: cuál usar es decisión del usuario y
 * `profileForWork` no elige por él. Para una sesión de WSL NO puede ser la
 * activa: el transcript vive en la raíz de esa distro y sólo esa cuenta sabe
 * llegar. Devuelve `null` si esa cuenta ya no existe, para poder explicarlo en
 * vez de abrir una terminal con la cuenta equivocada.
 */
export function cuentaParaSesion<T extends { id: string; entorno?: Entorno }>(
  sesion: { entorno: Entorno },
  cuentas: T[],
  activaId: string
): T | null {
  if (sesion.entorno.tipo !== 'wsl') return cuentas.find((c) => c.id === activaId) ?? null;
  const { distro } = sesion.entorno;
  return cuentas.find((c) => c.entorno?.tipo === 'wsl' && c.entorno.distro === distro) ?? null;
}
```

En `main.ts`, `sessions:resume` usa `cuentaParaSesion` y le pasa `session.entorno` a `openTerminalAs`. `sessions:new` sobre una cuenta WSL traduce la carpeta del diálogo con `windowsAPosix(distro, dir)` antes de lanzar.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/wsl.ts electron/wsl.test.ts electron/main.ts
git commit -m "feat: reanudar y crear sesiones en la distro que las tiene"
```

---

### Task 13: Login dentro de la distro

**Files:**
- Modify: `electron/login.ts:79`

**Interfaces:**
- Consumes: `Entorno`.
- Produces: nada.

- [ ] **Step 1: Write the failing test**

```ts
// electron/login.test.ts
import { comandoDeLogin } from './login';

describe('comandoDeLogin', () => {
  it('en Windows, como hoy: un .cmd que necesita shell', () => {
    expect(comandoDeLogin({ tipo: 'windows' })).toEqual({
      command: 'claude',
      args: ['auth', 'login'],
      shell: true
    });
  });

  it('en WSL corre adentro de la distro, no el CLI de Windows', () => {
    expect(comandoDeLogin({ tipo: 'wsl', distro: 'Ubuntu', home: '/home/v' })).toEqual({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--', 'bash', '-lc', 'claude auth login'],
      shell: false
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/login.test.ts`
Expected: FAIL — no exportada.

- [ ] **Step 3: Write minimal implementation**

```ts
/** Con qué se lanza el login. En Windows es un `.cmd`, que desde Node 20 no se
 *  puede spawnear sin shell; en WSL es el CLI de la distro, y ahí no hace falta
 *  shell porque `wsl.exe` es un ejecutable de verdad. */
export function comandoDeLogin(entorno: Entorno): {
  command: string;
  args: string[];
  shell: boolean;
} {
  if (entorno.tipo === 'wsl') {
    return {
      command: 'wsl.exe',
      args: ['-d', entorno.distro, '--', 'bash', '-lc', 'claude auth login'],
      shell: false
    };
  }
  return { command: 'claude', args: ['auth', 'login'], shell: true };
}
```

y usarla en el `spawn` de `login.ts:79`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/login.ts electron/login.test.ts
git commit -m "feat: el login de una cuenta WSL corre adentro de la distro"
```

---

### Task 14: Habilitar en la UI y aceptación manual

**Files:**
- Modify: `src/SessionList.tsx`

- [ ] **Step 1: Habilitar reanudar y crear**

Sacar el `disabled` de reanudar y crear para sesiones WSL. **El borrado sigue en ⛔** (§9 del spec).

- [ ] **Step 2: Verificación en esta máquina (sin CLI en la distro)**

Sustituir temporalmente el comando por `echo` y comprobar que llegan bien las tres cosas que pueden fallar:

```bash
wsl -d Ubuntu --cd /home/$USER -- bash -lc 'export CLAUDE_CONFIG_DIR=/home/'$USER'/.claude
printf "\n  Cuenta: %s\n\n" "Cuenta A"
echo "cwd=$PWD config=$CLAUDE_CONFIG_DIR"'
```

Expected: imprime el banner, `cwd=/home/<vos>` y `config=/home/<vos>/.claude`.

- [ ] **Step 3: Aceptación manual — REQUIERE OTRA MÁQUINA**

En esta máquina **no hay `claude` instalado en WSL** (verificado: `command -v claude` vacío), así que un reanudar real y un login real **no se pueden probar acá**. Va en la PC del equipo que sí lo tiene:

1. Dar de alta la cuenta WSL. Debe encontrar la distro y el `$HOME`.
2. Ver las sesiones creadas desde Ubuntu, con el chip de la distro.
3. Reanudar una: la terminal abre en la carpeta correcta, con el banner de la cuenta, y `claude --resume` levanta la conversación.
4. Crear una nueva eligiendo una carpeta de Windows en el diálogo: debe abrir en `/mnt/c/...`.
5. Login de la cuenta WSL.
6. Confirmar que las cuentas de Windows y el botón de Desktop siguen andando igual.

**Hasta que esos seis pasos estén hechos, esto se reporta como "pendiente de aceptación", nunca como "probado".**

- [ ] **Step 4: Commit**

```bash
git add src/SessionList.tsx
git commit -m "feat: habilitar reanudar y crear en cuentas WSL"
```

---

## Auto-revisión del plan

**Cobertura del spec:**

| Sección del spec | Tarea |
|---|---|
| §4 modelo de datos | 2, 3 |
| §5.1 alta explícita, detección asistida | 1, 5, 7 |
| §5.2 de una raíz a N | 3, 6 |
| §5.3 el 16x (medir, no construir) | 8 |
| §5.4 nunca sondear la UNC a ciegas | 5, y verificación explícita en 7 |
| §5.5 fronteras de la rebanada 1 | 7 |
| §6.1–6.4 lanzador, export, rutas, comillas | 9, 10, 11 |
| §6.5 login | 13 |
| §7 Desktop deshabilitado | 7 |
| §8.1 guard de borrado | 4 |
| §8.2 estados de raíz | 2, 7 |
| §8.3 la carrera | 6 (`leerRaiz` reconsulta si la raíz vino vacía, para no confundir "sin sesiones" con "se apagó") |
| §8.4 timeouts | 5 |
| §9 borrado en ⛔ | 7, 14 |
| §10 plan de pruebas | 8, 14 |
| §11 archivos afectados | tabla de arriba |

**Consistencia de tipos:** `Entorno`, `EstadoRaiz`, `Raiz`, `SessionMeta.raiz`/`.entorno` se definen en las tareas 2–3 y se usan con los mismos nombres en 4–14. `listSessions` tiene dos parámetros desde la Task 3 en adelante, en todos los llamadores.

**Riesgo conocido que el plan no resuelve:** la aceptación real (Task 14, Step 3) depende de una máquina que no es la de desarrollo. Está marcado como tal y no se reporta como probado.
