# Telegram remoto — plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usar superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans para implementar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`) para el seguimiento.

**Objetivo:** seguir y manejar desde Telegram (permisos, preguntas, instrucciones, imágenes, estado) las sesiones de Claude Code de todas las cuentas cuando el usuario no está en la PC.

**Arquitectura:** todo corre en el proceso main de claude-monitor. Un hook (`remoto-hook.js`) instalado en las cuentas le hace POST a un endpoint local (`remoto-servidor.ts`). El puente (`puente.ts`) decide si el usuario está fuera (`presencia.ts`), manda el evento al tema de Telegram de esa sesión (`telegram.ts`), espera la respuesta y la devuelve como el JSON que espera el hook. Las sesiones que ya estaban quietas se "toman" y siguen con `claude -p --resume` (`tomar.ts`). `remoto.ts` arma todas las piezas y expone el IPC de la sección de configuración (`src/TelegramPanel.tsx`).

**Tecnologías:** Electron 33, TypeScript, React 18, vitest, Node `http`/`fetch`/`child_process`, Bot API de Telegram, PowerShell con `Add-Type` para la tapa.

**Especificación:** `docs/superpowers/specs/2026-09-28-telegram-remoto-design.md`. Hay que leerla antes de empezar; este plan se apoya en ella.

## Restricciones globales

- **Sin dependencias nuevas** en `package.json`: sólo `fetch`, `http`, `child_process`, `fs` y APIs de Electron (`safeStorage`, `powerMonitor`).
- **Comentarios en español rioplatense**, con el estilo del repo (explican el porqué, no el qué).
- **Commits** con el formato de la skill `ticket-commit-format`: la cabecera es el nombre de la rama sin el prefijo (`telegram-remoto`), una línea en blanco y después `- cambio.` por línea. **Nunca** `Co-Authored-By` ni menciones a Claude.
- **Rama:** `feature/telegram-remoto`, creada desde `master` (con superpowers:using-git-worktrees).
- **Solo Windows:** las cuentas con `entorno.tipo === 'wsl'` no reciben el hook ni se toman.
- **Texto a Telegram siempre plano:** nunca `parse_mode` (el código trae `_`, `*` y `` ` ``, que rompen Markdown/HTML), y recortado a 4096 caracteres.
- **El prefijo exacto del mensaje del usuario:** `[claude-monitor · Telegram] El usuario respondió: `.
- **El hook nunca traba una sesión:** ante cualquier error, `remoto-hook.js` escribe `{}` y sale con código 0.
- **Timeout del hook:** `86400` s en cada entrada de `settings.json`.
- **Archivos de datos:** `%APPDATA%\claude-monitor\telegram.json` (configuración y temas), `%APPDATA%\claude-monitor\remoto.json` (puerto y token del endpoint), `%APPDATA%\claude-monitor\hooks\remoto-hook.js`, y las imágenes en `%LOCALAPPDATA%\claude-monitor\telegram\<sessionId>\`.
- **Versión:** 0.23.0.

## Foco de revisión

Casos que la especificación implica y que conviene tener cubiertos, empezando por el más probable. Cada uno tiene su test en la tarea que lo implementa:

1. **Respuesta que llega después de soltar la espera** (el usuario volvió a la PC y después tocó un botón viejo): se contesta "ya no está vigente" y **no** se aplica a la espera siguiente de la misma sesión. → Tarea 6.
2. **Mensaje en el tema General o fuera de un tema** (sin `message_thread_id`): nunca se le asigna a una sesión cualquiera; se contesta con la ayuda. → Tarea 6.
3. **Servidor HTTP de Node cortando esperas largas:** por defecto `requestTimeout` es 300 s; con eso un permiso se soltaría solo a los 5 minutos. Tiene que ser `0`. → Tarea 4.
4. **Una sesión tomada que termina su turno `-p`:** su hook `Stop` no puede quedarse esperando (trabaría el proceso `-p`). El hook sale con `{}` si `CLAUDE_MONITOR_TOMADA=1`. → Tareas 4 y 7.
5. **Dos sesiones en la misma carpeta:** los temas se asocian por `sessionId`, nunca por nombre; los nombres de tema pueden repetirse. → Tarea 6.

---

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `electron/telegram.ts` | Cliente de la Bot API y bucle de long polling |
| `electron/remoto-formato.ts` | Funciones puras: textos, botones y respuestas JSON del hook |
| `electron/presencia.ts` | Modo fuera: manual, tapa e inactividad |
| `electron/tapa.ps1` | Ayudante que escribe `lid 0` / `lid 1` |
| `electron/remoto-servidor.ts` | Endpoint local `POST /hook` con token |
| `electron/hooks/remoto-hook.js` | Script del hook (CommonJS, sin dependencias) |
| `electron/puente.ts` | Esperas pendientes, ruteo de mensajes, temas, vinculación, comandos |
| `electron/tomar.ts` | Toma de sesiones quietas y turnos `claude -p --resume` |
| `electron/remoto-instalar.ts` | Instala y saca el hook en el `settings.json` del pozo |
| `electron/remoto-config.ts` | Lectura y escritura de `telegram.json`, token cifrado |
| `electron/remoto.ts` | Arma las piezas, ciclo de vida e IPC |
| `src/TelegramPanel.tsx` | La sección de configuración y "Continuadas desde Telegram" |
| `electron/main.ts`, `electron/preload.ts`, `shared/types.ts`, `src/App.tsx`, `src/index.css` | Conexión con lo existente |
| `electron/oficina.ts` | Se exporta `iniciosDeProceso` |
| `package.json`, `README.md` | `extraResources`, versión y guía |

---

### Tarea 1: prueba de la tapa y el ayudante `tapa.ps1`

Hay que confirmar primero que el portátil emite el evento. Si no lo emite, la tarea se cierra con el ayudante igual commiteado (sirve en otros equipos) y la Tarea 3 depende sólo de la inactividad.

**Archivos:**
- Crear: `electron/tapa.ps1`

**Interfaces:**
- Produce: un proceso que escribe por stdout una línea `lid 0` (cerrada) o `lid 1` (abierta) en cada cambio, y la primera apenas arranca. Sale solo si se cierra su stdin.

- [ ] **Paso 1: escribir el ayudante**

```powershell
# El estado de la tapa, para el modo fuera de Telegram (ver presencia.ts).
#
# Windows avisa los cambios de la tapa con un evento de energía
# (GUID_LIDSWITCH_STATE_CHANGE) que sólo llega a una ventana registrada con
# RegisterPowerSettingNotification. Electron no lo expone, así que esto crea
# una ventana oculta y escribe "lid 0" (cerrada) o "lid 1" (abierta) por stdout.
# Windows manda el estado actual apenas se registra.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class Tapa : NativeWindow {
  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr RegisterPowerSettingNotification(IntPtr h, ref Guid g, int flags);

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct Ajuste { public Guid Guid; public int Largo; public byte Dato; }

  static Guid LID = new Guid("BA3E0F4D-B817-4094-A2D1-D56379E6A0F3");
  const int WM_POWERBROADCAST = 0x0218;
  const int PBT_POWERSETTINGCHANGE = 0x8013;

  public Tapa() {
    CreateHandle(new CreateParams());
    RegisterPowerSettingNotification(Handle, ref LID, 0);
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_POWERBROADCAST && (int)m.WParam == PBT_POWERSETTINGCHANGE) {
      var a = (Ajuste)Marshal.PtrToStructure(m.LParam, typeof(Ajuste));
      if (a.Guid == LID) Console.Out.WriteLine("lid " + a.Dato);
      Console.Out.Flush();
    }
    base.WndProc(ref m);
  }
}
'@
$tapa = New-Object Tapa
# Si la app se cierra, se cierra el stdin: el ayudante se va con ella.
$lector = [System.IO.StreamReader]::new([Console]::OpenStandardInput())
$tarea = $lector.ReadLineAsync()
while (-not $tarea.IsCompleted) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200 }
```

- [ ] **Paso 2: probarlo en el portátil del usuario**

Correr en una terminal:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File electron\tapa.ps1
```

Esperado: enseguida aparece `lid 1`. El usuario cierra la tapa unos 10 s (con la acción "No hacer nada" al cerrar la tapa) y la vuelve a abrir. Esperado: aparecen `lid 0` y después `lid 1`. Cortar con Ctrl+C.

Si no aparece `lid 0`: anotarlo en el mensaje del commit ("el portátil no emite el evento; queda la inactividad") y seguir igual.

- [ ] **Paso 3: commit**

```bash
git add electron/tapa.ps1
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega el ayudante que avisa cuando se cierra o se abre la tapa del portátil.
EOF
)"
```

---

### Tarea 2: cliente de Telegram

**Archivos:**
- Crear: `electron/telegram.ts`
- Test: `electron/telegram.test.ts`

**Interfaces:**
- Produce:
  - `MAX_TEXTO = 4096`
  - `recortar(texto: string, max?: number): string`
  - `type Boton = { texto: string; dato: string }`
  - `type Mensaje = { message_id: number; chat: { id: number }; from?: { id: number }; message_thread_id?: number; is_topic_message?: boolean; text?: string; caption?: string; photo?: Array<{ file_id: string; file_size?: number }>; media_group_id?: string }`
  - `type Callback = { id: string; from: { id: number }; data?: string; message?: Mensaje }`
  - `type Update = { update_id: number; message?: Mensaje; callback_query?: Callback }`
  - `class TelegramError extends Error { codigo: number }`
  - `class Telegram` con `getMe()`, `actualizaciones(offset, esperaSeg?)`, `enviar(chatId, texto, { tema?, botones? })` → `message_id`, `editar(chatId, messageId, texto)`, `contestarBoton(callbackId, texto?)`, `crearTema(chatId, nombre)` → `message_thread_id`, `descargar(fileId, destino)` → ruta, `escuchar(offsetInicial, alRecibir, alOffset, señal)`

- [ ] **Paso 1: escribir los tests que fallan**

```ts
// electron/telegram.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MAX_TEXTO, recortar, Telegram, TelegramError } from './telegram';

const respuesta = (result: unknown, ok = true, error_code = 0) =>
  ({ json: async () => ({ ok, result, error_code, description: 'mal' }) }) as Response;

describe('recortar', () => {
  it('deja igual lo que entra', () => expect(recortar('hola')).toBe('hola'));
  it('corta lo que no entra y avisa con …', () => {
    const t = recortar('x'.repeat(MAX_TEXTO + 50));
    expect(t.length).toBe(MAX_TEXTO);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('Telegram', () => {
  it('manda texto plano, sin parse_mode, en el tema y con botones', async () => {
    const f = vi.fn(async () => respuesta({ message_id: 7 }));
    const tg = new Telegram('TOKEN', f as unknown as typeof fetch);
    const id = await tg.enviar(10, 'a_b*c', { tema: 3, botones: [[{ texto: 'Sí', dato: 'x:si' }]] });
    expect(id).toBe(7);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const cuerpo = JSON.parse(String(init.body));
    expect(cuerpo).toEqual({
      chat_id: 10,
      text: 'a_b*c',
      message_thread_id: 3,
      reply_markup: { inline_keyboard: [[{ text: 'Sí', callback_data: 'x:si' }]] }
    });
    expect(cuerpo.parse_mode).toBeUndefined();
  });

  it('un error de la API es un TelegramError con su código', async () => {
    const tg = new Telegram('T', (async () => respuesta(null, false, 401)) as unknown as typeof fetch);
    await expect(tg.getMe()).rejects.toMatchObject({ codigo: 401 });
    await expect(tg.getMe()).rejects.toBeInstanceOf(TelegramError);
  });

  it('escuchar avanza el offset y entrega cada update', async () => {
    const lotes = [[{ update_id: 5 }, { update_id: 6 }], []];
    const ctrl = new AbortController();
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const { offset } = JSON.parse(String(init.body));
      if (lotes.length === 1) ctrl.abort();
      return respuesta(lotes.shift() ?? [], true);
    });
    const tg = new Telegram('T', f as unknown as typeof fetch);
    const vistos: number[] = [];
    const offsets: number[] = [];
    await tg.escuchar(0, async (u) => void vistos.push(u.update_id), (o) => void offsets.push(o), ctrl.signal);
    expect(vistos).toEqual([5, 6]);
    expect(offsets).toEqual([7]);
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body)).offset).toBe(7);
  });
});
```

- [ ] **Paso 2: correrlos y ver que fallan**

Run: `npx vitest run electron/telegram.test.ts`
Esperado: FAIL, `Failed to resolve import "./telegram"`.

- [ ] **Paso 3: implementar**

```ts
// electron/telegram.ts
/**
 * Lo mínimo de la Bot API de Telegram para el puente remoto (ver
 * `docs/superpowers/specs/2026-09-28-telegram-remoto-design.md`).
 *
 * Sin dependencias: `fetch` alcanza. El texto va siempre plano, sin
 * `parse_mode`: lo que se manda es código y comandos, y un `_` o un `*` suelto
 * hace que Telegram rechace el mensaje entero si se lo interpreta como Markdown.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MAX_TEXTO = 4096;

export function recortar(texto: string, max = MAX_TEXTO): string {
  return texto.length <= max ? texto : `${texto.slice(0, max - 1)}…`;
}

export type Boton = { texto: string; dato: string };
export type Mensaje = {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  media_group_id?: string;
};
export type Callback = { id: string; from: { id: number }; data?: string; message?: Mensaje };
export type Update = { update_id: number; message?: Mensaje; callback_query?: Callback };

export class TelegramError extends Error {
  constructor(
    public codigo: number,
    mensaje: string
  ) {
    super(mensaje);
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Telegram {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  private async llamar<T>(metodo: string, params: Record<string, unknown>, señal?: AbortSignal): Promise<T> {
    const r = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: señal
    });
    const j = (await r.json()) as { ok: boolean; result: T; error_code?: number; description?: string };
    if (!j.ok) throw new TelegramError(j.error_code ?? 0, j.description ?? metodo);
    return j.result;
  }

  getMe(): Promise<{ username: string }> {
    return this.llamar('getMe', {});
  }

  actualizaciones(offset: number, esperaSeg = 50, señal?: AbortSignal): Promise<Update[]> {
    return this.llamar('getUpdates', { offset, timeout: esperaSeg, allowed_updates: ['message', 'callback_query'] }, señal);
  }

  async enviar(chatId: number, texto: string, op: { tema?: number; botones?: Boton[][] } = {}): Promise<number> {
    const m = await this.llamar<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: recortar(texto),
      ...(op.tema ? { message_thread_id: op.tema } : {}),
      ...(op.botones
        ? { reply_markup: { inline_keyboard: op.botones.map((f) => f.map((b) => ({ text: b.texto, callback_data: b.dato }))) } }
        : {})
    });
    return m.message_id;
  }

  /** Cambia el texto y, al no mandar `reply_markup`, le saca los botones. */
  async editar(chatId: number, messageId: number, texto: string): Promise<void> {
    await this.llamar('editMessageText', { chat_id: chatId, message_id: messageId, text: recortar(texto) });
  }

  async contestarBoton(callbackId: string, texto?: string): Promise<void> {
    await this.llamar('answerCallbackQuery', { callback_query_id: callbackId, ...(texto ? { text: texto } : {}) });
  }

  async crearTema(chatId: number, nombre: string): Promise<number> {
    const t = await this.llamar<{ message_thread_id: number }>('createForumTopic', { chat_id: chatId, name: nombre.slice(0, 128) });
    return t.message_thread_id;
  }

  async descargar(fileId: string, destino: string): Promise<string> {
    const f = await this.llamar<{ file_path: string }>('getFile', { file_id: fileId });
    const r = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`);
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, Buffer.from(await r.arrayBuffer()));
    return destino;
  }

  /**
   * Long polling hasta que se aborte `señal`. Un error de red espera y
   * reintenta con espera creciente (hasta 60 s); un 401 (token revocado) corta
   * el bucle lanzando, para que el puente se apague y avise.
   */
  async escuchar(
    offset: number,
    alRecibir: (u: Update) => Promise<void>,
    alOffset: (o: number) => void,
    señal: AbortSignal
  ): Promise<void> {
    let espera = 1000;
    while (!señal.aborted) {
      let lote: Update[];
      try {
        lote = await this.actualizaciones(offset, 50, señal);
        espera = 1000;
      } catch (e) {
        if (señal.aborted) return;
        if (e instanceof TelegramError && e.codigo === 401) throw e;
        await esperar(espera);
        espera = Math.min(espera * 2, 60_000);
        continue;
      }
      for (const u of lote) {
        await alRecibir(u).catch(() => {});
        offset = u.update_id + 1;
      }
      if (lote.length) alOffset(offset);
    }
  }
}
```

- [ ] **Paso 4: correrlos y ver que pasan**

Run: `npx vitest run electron/telegram.test.ts`
Esperado: PASS (5 tests).

- [ ] **Paso 5: commit**

```bash
git add electron/telegram.ts electron/telegram.test.ts
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega el cliente mínimo de la API de Telegram con long polling, temas, botones y descarga de archivos.
EOF
)"
```

---

### Tarea 3: modo fuera (`presencia.ts`)

**Archivos:**
- Crear: `electron/presencia.ts`
- Test: `electron/presencia.test.ts`

**Interfaces:**
- Consume: `electron/tapa.ps1` (Tarea 1): líneas `lid 0` y `lid 1`.
- Produce:
  - `type Motivo = 'manual' | 'tapa' | 'inactividad'`
  - `type EstadoPresencia = { fuera: boolean; motivo: Motivo | null }`
  - `evaluar(e: { manual: boolean | null; tapaCerrada: boolean | null; inactivoSeg: number }, umbralMin: number): EstadoPresencia`
  - `class Presencia` con `constructor(inactivoSeg: () => number, umbralMin: number, alCambiar: (e: EstadoPresencia) => void)`, `estado(): EstadoPresencia`, `setManual(v: boolean | null)`, `setTapa(cerrada: boolean)`, `setUmbral(min: number)`, `revisar()`
  - `lanzarAyudanteTapa(ruta: string, alCambiar: (cerrada: boolean) => void): () => void` (devuelve la función que lo cierra)

- [ ] **Paso 1: escribir los tests que fallan**

```ts
// electron/presencia.test.ts
import { describe, it, expect } from 'vitest';
import { evaluar, Presencia } from './presencia';

describe('evaluar', () => {
  const base = { manual: null, tapaCerrada: null, inactivoSeg: 0 };
  it('lo manual manda sobre todo', () => {
    expect(evaluar({ ...base, manual: false, tapaCerrada: true }, 10)).toEqual({ fuera: false, motivo: 'manual' });
    expect(evaluar({ ...base, manual: true }, 10)).toEqual({ fuera: true, motivo: 'manual' });
  });
  it('tapa cerrada es fuera al instante', () => {
    expect(evaluar({ ...base, tapaCerrada: true }, 10)).toEqual({ fuera: true, motivo: 'tapa' });
  });
  it('inactividad a partir del umbral', () => {
    expect(evaluar({ ...base, inactivoSeg: 599 }, 10).fuera).toBe(false);
    expect(evaluar({ ...base, inactivoSeg: 600 }, 10)).toEqual({ fuera: true, motivo: 'inactividad' });
  });
  it('tapa abierta y actividad: presente', () => {
    expect(evaluar({ ...base, tapaCerrada: false, inactivoSeg: 5 }, 10)).toEqual({ fuera: false, motivo: null });
  });
});

describe('Presencia', () => {
  it('avisa sólo los cambios y abrir la tapa borra lo manual', () => {
    let idle = 0;
    const cambios: boolean[] = [];
    const p = new Presencia(() => idle, 10, (e) => cambios.push(e.fuera));
    p.revisar();
    p.setManual(true);
    p.revisar();
    p.setTapa(true);
    p.setTapa(false);
    expect(cambios).toEqual([true, false]);
    idle = 700;
    p.revisar();
    expect(p.estado()).toEqual({ fuera: true, motivo: 'inactividad' });
  });
});
```

- [ ] **Paso 2: correrlos y ver que fallan**

Run: `npx vitest run electron/presencia.test.ts`
Esperado: FAIL, `Failed to resolve import "./presencia"`.

- [ ] **Paso 3: implementar**

```ts
// electron/presencia.ts
/**
 * Si el usuario está fuera de la PC (spec §7). En orden: lo manual (`/fuera`,
 * `/vuelvo` o el interruptor de la app), la tapa cerrada, y la inactividad de
 * teclado y mouse. La tapa importa porque el portátil queda prendido con la tapa
 * cerrada y nunca se bloquea: sin eso sólo quedaría esperar la inactividad.
 */

import { spawn } from 'node:child_process';

export type Motivo = 'manual' | 'tapa' | 'inactividad';
export type EstadoPresencia = { fuera: boolean; motivo: Motivo | null };

export function evaluar(
  e: { manual: boolean | null; tapaCerrada: boolean | null; inactivoSeg: number },
  umbralMin: number
): EstadoPresencia {
  if (e.manual !== null) return { fuera: e.manual, motivo: 'manual' };
  if (e.tapaCerrada === true) return { fuera: true, motivo: 'tapa' };
  if (e.inactivoSeg >= umbralMin * 60) return { fuera: true, motivo: 'inactividad' };
  return { fuera: false, motivo: null };
}

export class Presencia {
  private manual: boolean | null = null;
  private tapaCerrada: boolean | null = null;
  private actual: EstadoPresencia = { fuera: false, motivo: null };

  constructor(
    private inactivoSeg: () => number,
    private umbralMin: number,
    private alCambiar: (e: EstadoPresencia) => void
  ) {}

  estado(): EstadoPresencia {
    return this.actual;
  }

  setManual(v: boolean | null): void {
    this.manual = v;
    this.revisar();
  }

  /** Un cambio de la tapa gana sobre lo manual: abrirla es volver, cerrarla es irse. */
  setTapa(cerrada: boolean): void {
    this.tapaCerrada = cerrada;
    this.manual = null;
    this.revisar();
  }

  setUmbral(min: number): void {
    this.umbralMin = min;
    this.revisar();
  }

  revisar(): void {
    const nuevo = evaluar({ manual: this.manual, tapaCerrada: this.tapaCerrada, inactivoSeg: this.inactivoSeg() }, this.umbralMin);
    if (nuevo.fuera === this.actual.fuera && nuevo.motivo === this.actual.motivo) return;
    const cambioFuera = nuevo.fuera !== this.actual.fuera;
    this.actual = nuevo;
    if (cambioFuera) this.alCambiar(nuevo);
  }
}

/** Lanza `tapa.ps1` y avisa cada cambio. Si no arranca, no pasa nada: queda la inactividad. */
export function lanzarAyudanteTapa(ruta: string, alCambiar: (cerrada: boolean) => void): () => void {
  const hijo = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ruta], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  });
  let resto = '';
  hijo.stdout?.on('data', (d: Buffer) => {
    resto += d.toString();
    const lineas = resto.split(/\r?\n/);
    resto = lineas.pop() ?? '';
    for (const l of lineas) {
      const m = /^lid ([01])$/.exec(l.trim());
      if (m) alCambiar(m[1] === '0');
    }
  });
  hijo.on('error', () => {});
  return () => {
    hijo.stdin?.end();
    hijo.kill();
  };
}
```

- [ ] **Paso 4: correrlos y ver que pasan**

Run: `npx vitest run electron/presencia.test.ts`
Esperado: PASS (5 tests).

- [ ] **Paso 5: commit**

```bash
git add electron/presencia.ts electron/presencia.test.ts
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega el modo fuera, que se activa a mano, con la tapa cerrada o por inactividad.
EOF
)"
```

---

### Tarea 4: endpoint local y script del hook

**Archivos:**
- Crear: `electron/remoto-servidor.ts`
- Crear: `electron/hooks/remoto-hook.js`
- Test: `electron/remoto-servidor.test.ts`

**Interfaces:**
- Produce:
  - `type EventoHook = { hook_event_name: string; session_id: string; transcript_path?: string; cwd?: string; tool_name?: string; tool_input?: Record<string, unknown>; stop_hook_active?: boolean }`
  - `iniciarServidor(archivo: string, atender: (ev: EventoHook) => Promise<object>): Promise<{ port: number; token: string; servidor: Server; cerrar: () => Promise<void> }>`. Escribe `archivo` con `{ port, token }` y lo borra al cerrar.
  - `remoto-hook.js`: lee el evento por stdin y `%APPDATA%\claude-monitor\remoto.json`, hace POST y escribe la respuesta. Con `CLAUDE_MONITOR_TOMADA=1` y un evento `Stop`, escribe `{}` sin preguntar. Cualquier error: `{}`.

- [ ] **Paso 1: escribir los tests que fallan**

```ts
// electron/remoto-servidor.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iniciarServidor } from './remoto-servidor';

const HOOK = join(__dirname, 'hooks', 'remoto-hook.js');
let dir = '';
afterEach(async () => dir && rm(dir, { recursive: true, force: true }));

/** Corre el hook como lo haría Claude Code: evento por stdin, respuesta por stdout. */
function correrHook(appdata: string, evento: object, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((ok, mal) => {
    const h = execFile(process.execPath, [HOOK], { env: { ...process.env, APPDATA: appdata, ...extraEnv } }, (err, out) =>
      err ? mal(err) : ok(out)
    );
    h.stdin!.end(JSON.stringify(evento));
  });
}

describe('endpoint y hook', () => {
  it('el hook manda el evento y escribe lo que contesta el puente', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const archivo = join(dir, 'claude-monitor', 'remoto.json');
    const vistos: string[] = [];
    const srv = await iniciarServidor(archivo, async (ev) => {
      vistos.push(ev.hook_event_name);
      return { decision: 'block', reason: 'hola' };
    });
    expect(JSON.parse(await readFile(archivo, 'utf8'))).toEqual({ port: srv.port, token: srv.token });
    const out = await correrHook(dir, { hook_event_name: 'Stop', session_id: 's' });
    expect(JSON.parse(out)).toEqual({ decision: 'block', reason: 'hola' });
    expect(vistos).toEqual(['Stop']);
    await srv.cerrar();
    expect(existsSync(archivo)).toBe(false);
  });

  it('sin la app corriendo, el hook escribe {} y no traba nada', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    expect(JSON.parse(await correrHook(dir, { hook_event_name: 'Stop', session_id: 's' }))).toEqual({});
  });

  it('una sesión tomada no espera en su Stop', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const srv = await iniciarServidor(join(dir, 'claude-monitor', 'remoto.json'), async () => ({ decision: 'block', reason: 'x' }));
    const out = await correrHook(dir, { hook_event_name: 'Stop', session_id: 's' }, { CLAUDE_MONITOR_TOMADA: '1' });
    expect(JSON.parse(out)).toEqual({});
    await srv.cerrar();
  });

  it('rechaza un token equivocado', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const srv = await iniciarServidor(join(dir, 'r.json'), async () => ({ x: 1 }));
    const r = await fetch(`http://127.0.0.1:${srv.port}/hook`, { method: 'POST', headers: { Authorization: 'Bearer otro' }, body: '{}' });
    expect(r.status).toBe(401);
    await srv.cerrar();
  });

  it('no corta esperas largas: requestTimeout en 0', async () => {
    dir = await mkdtemp(join(tmpdir(), 'remoto-'));
    const srv = await iniciarServidor(join(dir, 'r.json'), async () => ({}));
    expect(srv.servidor.requestTimeout).toBe(0);
    expect(srv.servidor.headersTimeout).toBeGreaterThan(0);
    await srv.cerrar();
  });
});
```

- [ ] **Paso 2: correrlos y ver que fallan**

Run: `npx vitest run electron/remoto-servidor.test.ts`
Esperado: FAIL, `Failed to resolve import "./remoto-servidor"`.

- [ ] **Paso 3: implementar el endpoint**

```ts
// electron/remoto-servidor.ts
/**
 * El endpoint local al que le habla `hooks/remoto-hook.js`. Sólo en 127.0.0.1 y
 * con un token que se guarda en `remoto.json`, igual que hace Pixel Agents con
 * `server.json`. Una espera puede durar horas (un permiso que se contesta desde
 * el celular), así que el servidor no corta pedidos largos: Node trae
 * `requestTimeout` en 300 s por defecto, y con eso cada espera se soltaría sola
 * a los 5 minutos.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type EventoHook = {
  hook_event_name: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
};

export async function iniciarServidor(
  archivo: string,
  atender: (ev: EventoHook) => Promise<object>
): Promise<{ port: number; token: string; servidor: Server; cerrar: () => Promise<void> }> {
  const token = randomUUID();
  const servidor = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let cuerpo = '';
    req.on('data', (d) => (cuerpo += d));
    req.on('end', async () => {
      let salida: object = {};
      try {
        salida = await atender(JSON.parse(cuerpo) as EventoHook);
      } catch {
        salida = {};
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(salida));
    });
  });
  servidor.requestTimeout = 0;
  servidor.headersTimeout = 60_000;
  servidor.keepAliveTimeout = 5_000;
  servidor.timeout = 0;
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const port = (servidor.address() as { port: number }).port;
  await mkdir(dirname(archivo), { recursive: true });
  await writeFile(archivo, JSON.stringify({ port, token }), 'utf8');
  return {
    port,
    token,
    servidor,
    cerrar: async () => {
      servidor.closeAllConnections();
      await new Promise<void>((ok) => servidor.close(() => ok()));
      await rm(archivo, { force: true });
    }
  };
}
```

- [ ] **Paso 4: implementar el hook**

```js
// electron/hooks/remoto-hook.js
// Hook de claude-monitor para el puente de Telegram (PermissionRequest,
// PreToolUse de AskUserQuestion, Stop y SessionStart). Le pasa el evento a la
// app y escribe lo que la app contesta. Nunca traba una sesión: sin la app, con
// un error o con cualquier cosa rara, escribe {} y Claude Code sigue como si el
// hook no existiera.
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const vacio = () => {
  process.stdout.write('{}');
  process.exit(0);
};

let entrada = '';
process.stdin.on('data', (d) => (entrada += d));
process.stdin.on('end', () => {
  try {
    const evento = JSON.parse(entrada);
    // Una sesión que la app tomó corre con `claude -p`: esperar en su Stop
    // trabaría ese proceso. La app manda el siguiente turno por su cuenta.
    if (process.env.CLAUDE_MONITOR_TOMADA === '1' && evento.hook_event_name === 'Stop') return vacio();
    const archivo = path.join(process.env.APPDATA || '', 'claude-monitor', 'remoto.json');
    const { port, token } = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    const req = http.request(
      { host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      (res) => {
        let salida = '';
        res.on('data', (d) => (salida += d));
        res.on('end', () => {
          try {
            JSON.parse(salida);
            process.stdout.write(salida);
            process.exit(0);
          } catch {
            vacio();
          }
        });
      }
    );
    req.on('error', vacio);
    req.end(JSON.stringify(evento));
  } catch {
    vacio();
  }
});
```

- [ ] **Paso 5: correr los tests y ver que pasan**

Run: `npx vitest run electron/remoto-servidor.test.ts`
Esperado: PASS (5 tests).

- [ ] **Paso 6: commit**

```bash
git add electron/remoto-servidor.ts electron/remoto-servidor.test.ts electron/hooks/remoto-hook.js
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega el endpoint local con token y el hook que le pasa los eventos de Claude Code.
- Se deja el hook sin efecto cuando la app no corre o cuando la sesión está tomada.
EOF
)"
```

---

### Tarea 5: textos, botones y respuestas del hook (`remoto-formato.ts`)

**Archivos:**
- Crear: `electron/remoto-formato.ts`
- Test: `electron/remoto-formato.test.ts`

**Interfaces:**
- Consume: `EventoHook` (Tarea 4), `Boton` (Tarea 2), `AgenteOficina` de `shared/types.ts`.
- Produce:
  - `PREFIJO = '[claude-monitor · Telegram] El usuario respondió: '`
  - `type Pregunta = { question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }`
  - `textoPermiso(ev: EventoHook): string`
  - `botonesPermiso(id: string): Boton[][]`
  - `textoPregunta(p: Pregunta): string`
  - `botonesPregunta(id: string, p: Pregunta, marcadas: Set<number>): Boton[][]`
  - `textoFin(ultimo: string): string`
  - `respuestaPermiso(permitir: boolean): object`
  - `respuestaPregunta(toolInput: Record<string, unknown>, respuestas: Record<string, string>): object`
  - `conImagenes(texto: string, imagenes: string[]): string` (el texto más la lista de rutas, si hay)
  - `respuestaStop(texto: string, imagenes: string[]): object`
  - `contextoInicio(): object`
  - `nombreTema(a: Pick<AgenteOficina, 'cwd' | 'nombre' | 'profileName'>): string`
  - `leerDato(dato: string): { id: string; accion: string } | null`

- [ ] **Paso 1: escribir los tests que fallan**

```ts
// electron/remoto-formato.test.ts
import { describe, it, expect } from 'vitest';
import {
  PREFIJO,
  botonesPregunta,
  contextoInicio,
  leerDato,
  nombreTema,
  respuestaPermiso,
  respuestaPregunta,
  respuestaStop,
  textoPermiso
} from './remoto-formato';

const pregunta = { question: '¿Color?', multiSelect: false, options: [{ label: 'Rojo' }, { label: 'Verde' }] };

describe('respuestas del hook (formatos medidos en la prueba del 2026-09-28)', () => {
  it('permiso', () => {
    expect(respuestaPermiso(true)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(respuestaPermiso(false)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Rechazado desde Telegram.' } }
    });
  });
  it('pregunta: allow con answers en updatedInput, sin perder el resto', () => {
    const input = { questions: [pregunta] };
    expect(respuestaPregunta(input, { '¿Color?': 'Verde' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { questions: [pregunta], answers: { '¿Color?': 'Verde' } }
      }
    });
  });
  it('stop: block con el prefijo y las imágenes', () => {
    expect(respuestaStop('corré los tests', ['C:/i/1.jpg'])).toEqual({
      decision: 'block',
      reason: `${PREFIJO}corré los tests\n\nImágenes adjuntas (abrilas con Read):\n- C:/i/1.jpg`
    });
  });
  it('el contexto de inicio explica el prefijo', () => {
    const c = contextoInicio() as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(c.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(c.hookSpecificOutput.additionalContext).toContain(PREFIJO.trim());
  });
});

describe('textos y botones', () => {
  it('el permiso muestra el comando', () => {
    expect(textoPermiso({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' } })).toBe(
      '🔐 Pide permiso: Bash\nnpm test'
    );
  });
  it('varias opciones: marcadas con ✅ y un botón Listo', () => {
    const b = botonesPregunta('ab12', { ...pregunta, multiSelect: true }, new Set([1]));
    expect(b.map((f) => f[0].texto)).toEqual(['Rojo', '✅ Verde', 'Listo']);
    expect(b[1][0].dato).toBe('ab12:o1');
    expect(b[2][0].dato).toBe('ab12:listo');
  });
  it('datos de botón: se leen y lo ajeno da null', () => {
    expect(leerDato('ab12:si')).toEqual({ id: 'ab12', accion: 'si' });
    expect(leerDato('basura')).toBeNull();
  });
  it('nombre del tema: carpeta · sesión · cuenta', () => {
    expect(nombreTema({ cwd: 'C:\\repos\\VendigMachine', nombre: 'migracion', profileName: 'MAX' })).toBe('VendigMachine · migracion · MAX');
  });
});
```

- [ ] **Paso 2: correrlos y ver que fallan**

Run: `npx vitest run electron/remoto-formato.test.ts`
Esperado: FAIL, `Failed to resolve import "./remoto-formato"`.

- [ ] **Paso 3: implementar**

```ts
// electron/remoto-formato.ts
/**
 * Lo que el puente de Telegram muestra y lo que le contesta al hook. Todo puro,
 * para probarlo sin red. Los JSON de respuesta son los que se midieron en la
 * prueba del 2026-09-28 (spec §2): otro formato y Claude Code los ignora sin
 * avisar.
 */

import { basename } from 'node:path';
import type { AgenteOficina } from '../shared/types';
import type { EventoHook } from './remoto-servidor';
import type { Boton } from './telegram';

export const PREFIJO = '[claude-monitor · Telegram] El usuario respondió: ';

export type Pregunta = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

function detalle(input: Record<string, unknown> = {}): string {
  for (const k of ['command', 'file_path', 'path', 'url', 'pattern']) if (typeof input[k] === 'string') return input[k] as string;
  return JSON.stringify(input);
}

export function textoPermiso(ev: EventoHook): string {
  return `🔐 Pide permiso: ${ev.tool_name ?? '?'}\n${detalle(ev.tool_input)}`;
}

export const botonesPermiso = (id: string): Boton[][] => [
  [
    { texto: '✅ Permitir', dato: `${id}:si` },
    { texto: '❌ Rechazar', dato: `${id}:no` }
  ]
];

export function textoPregunta(p: Pregunta): string {
  const opciones = p.options.map((o) => `• ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
  const pie = p.multiSelect ? 'Marcá las que quieras y tocá Listo.' : 'Tocá una, o escribí otra respuesta.';
  return `❓ ${p.question}\n\n${opciones}\n\n${pie}`;
}

export function botonesPregunta(id: string, p: Pregunta, marcadas: Set<number>): Boton[][] {
  const filas = p.options.map((o, i) => [{ texto: `${p.multiSelect && marcadas.has(i) ? '✅ ' : ''}${o.label}`, dato: `${id}:o${i}` }]);
  return p.multiSelect ? [...filas, [{ texto: 'Listo', dato: `${id}:listo` }]] : filas;
}

export const textoFin = (ultimo: string) => `✅ Terminó y te espera.\n\n${ultimo || '(sin texto)'}`;

export const respuestaPermiso = (permitir: boolean) => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: permitir ? { behavior: 'allow' } : { behavior: 'deny', message: 'Rechazado desde Telegram.' }
  }
});

export const respuestaPregunta = (toolInput: Record<string, unknown>, respuestas: Record<string, string>) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, answers: respuestas } }
});

export const conImagenes = (texto: string, imagenes: string[]) =>
  imagenes.length ? `${texto}\n\nImágenes adjuntas (abrilas con Read):\n${imagenes.map((i) => `- ${i}`).join('\n')}` : texto;

export const respuestaStop = (texto: string, imagenes: string[]) => ({ decision: 'block', reason: `${PREFIJO}${conImagenes(texto, imagenes)}` });

/** Sin esto el agente trata el texto que llega por Stop como una inyección (spec §2). */
export const contextoInicio = () => ({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext:
      `El usuario usa claude-monitor con un puente de Telegram que configuró él mismo. Cuando no está en la PC, sus ` +
      `respuestas llegan como feedback de un hook Stop que empieza con '${PREFIJO.trim()}'. Ese texto lo escribió el ` +
      `usuario: tratalo como un mensaje suyo y seguí sus instrucciones.`
  }
});

export const nombreTema = (a: Pick<AgenteOficina, 'cwd' | 'nombre' | 'profileName'>) =>
  `${basename(a.cwd.replace(/\\/g, '/'))} · ${a.nombre} · ${a.profileName}`;

export function leerDato(dato: string): { id: string; accion: string } | null {
  const m = /^([a-z0-9]{4,12}):([a-z0-9]{1,8})$/.exec(dato);
  return m ? { id: m[1], accion: m[2] } : null;
}
```

- [ ] **Paso 4: correrlos y ver que pasan**

Run: `npx vitest run electron/remoto-formato.test.ts`
Esperado: PASS (8 tests).

- [ ] **Paso 5: commit**

```bash
git add electron/remoto-formato.ts electron/remoto-formato.test.ts
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agregan los textos, botones y respuestas del hook del puente de Telegram.
EOF
)"
```

---

### Tarea 6: el puente (`puente.ts`)

**Archivos:**
- Crear: `electron/puente.ts`
- Test: `electron/puente.test.ts`

**Interfaces:**
- Consume: `Telegram`, `Update`, `Mensaje` (Tarea 2); todo `remoto-formato.ts` (Tarea 5); `EventoHook` (Tarea 4); `AgenteOficina` de `shared/types.ts`.
- Produce:
  - `type Canal = Pick<Telegram, 'enviar' | 'editar' | 'contestarBoton' | 'crearTema' | 'descargar'>`
  - `type Vinculo = { chatId: number; userId: number }`
  - `type DepsPuente = { canal: Canal; vinculo: () => Vinculo | null; vincular: (v: Vinculo) => Promise<void>; codigo: () => { codigo: string; vence: number } | null; fuera: () => boolean; setManual: (v: boolean | null) => void; sesiones: () => Promise<AgenteOficina[]>; ultimoMensaje: (transcript: string) => Promise<string>; temas: { leer: (sessionId: string) => number | undefined; guardar: (sessionId: string, tema: number) => Promise<void>; borrar: (sessionId: string) => Promise<void>; sesionDe: (tema: number) => string | undefined }; carpetaImagenes: string; tomar: (sessionId: string, texto: string) => Promise<void>; esperaAlbumMs?: number; esperaReintentoMs?: number }`
  - `class Puente` con `atenderHook(ev: EventoHook): Promise<object>`, `atenderUpdate(u: Update): Promise<void>`, `soltarTodo(): Promise<void>`

- [ ] **Paso 1: escribir los tests que fallan**

```ts
// electron/puente.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Puente, type DepsPuente } from './puente';
import type { AgenteOficina } from '../shared/types';

const CHAT = -100;
const YO = 42;
const agente = (sessionId: string, estado: AgenteOficina['estado'] = 'esperando'): AgenteOficina => ({
  sessionId, profileId: 'p', profileName: 'MAX', nombre: 'migracion', nombrePropio: '', nota: '', cwd: 'C:/repos/Vendig',
  origen: 'terminal', transcript: `C:/t/${sessionId}.jsonl`, estado, herramienta: '', detalle: '', subagentes: [], mensajes: []
});

function armar(extra: Partial<DepsPuente> = {}) {
  const enviados: Array<{ texto: string; tema?: number; botones?: unknown }> = [];
  const temas = new Map<string, number>();
  let fuera = true;
  let proximoTema = 900;
  const deps: DepsPuente = {
    canal: {
      enviar: vi.fn(async (_c: number, texto: string, op: { tema?: number; botones?: unknown } = {}) => {
        enviados.push({ texto, ...op });
        return enviados.length;
      }),
      editar: vi.fn(async () => {}),
      contestarBoton: vi.fn(async () => {}),
      crearTema: vi.fn(async () => ++proximoTema),
      descargar: vi.fn(async (_f: string, d: string) => d)
    },
    vinculo: () => ({ chatId: CHAT, userId: YO }),
    vincular: vi.fn(async () => {}),
    codigo: () => null,
    fuera: () => fuera,
    setManual: vi.fn(),
    sesiones: async () => [agente('s1'), agente('s2', 'escribiendo')],
    ultimoMensaje: async () => 'Listo, terminé.',
    temas: {
      leer: (s) => temas.get(s),
      guardar: async (s, t) => void temas.set(s, t),
      borrar: async (s) => void temas.delete(s),
      sesionDe: (t) => [...temas].find(([, v]) => v === t)?.[0]
    },
    carpetaImagenes: 'C:/img',
    tomar: vi.fn(async () => {}),
    esperaAlbumMs: 0,
    esperaReintentoMs: 0,
    ...extra
  };
  return { p: new Puente(deps), deps, enviados, temas, setFuera: (v: boolean) => (fuera = v) };
}

const texto = (t: string, tema?: number, de = YO) => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: CHAT }, from: { id: de }, message_thread_id: tema, is_topic_message: !!tema, text: t }
});
const boton = (dato: string, de = YO) => ({ update_id: 2, callback_query: { id: 'cb', from: { id: de }, data: dato } });
const idDe = (botones: unknown) => ((botones as Array<Array<{ dato: string }>>)[0][0].dato).split(':')[0];
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Puente', () => {
  it('sin modo fuera contesta {} al instante', async () => {
    const { p, setFuera } = armar();
    setFuera(false);
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' })).toEqual({});
  });

  it('permiso: manda al tema de la sesión y aplica el botón', async () => {
    const { p, enviados, temas } = armar();
    const espera = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    await tick();
    expect(enviados[0].tema).toBe(temas.get('s1'));
    await p.atenderUpdate(boton(`${idDe(enviados[0].botones)}:si`));
    expect(await espera).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('stop: el texto en el tema es la instrucción siguiente', async () => {
    const { p, temas } = armar();
    const espera = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1', transcript_path: 'C:/t/s1.jsonl' });
    await tick();
    await p.atenderUpdate(texto('corré los tests', temas.get('s1')));
    expect(await espera).toMatchObject({ decision: 'block', reason: expect.stringContaining('corré los tests') });
  });

  it('pregunta: el botón da la opción y el texto libre cuenta como Otro', async () => {
    const { p, enviados, temas } = armar();
    const input = { questions: [{ question: '¿Color?', options: [{ label: 'Rojo' }, { label: 'Verde' }] }] };
    const e1 = p.atenderHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion', tool_input: input });
    await tick();
    await p.atenderUpdate(boton(`${idDe(enviados[0].botones)}:o1`));
    expect(await e1).toMatchObject({ hookSpecificOutput: { updatedInput: { answers: { '¿Color?': 'Verde' } } } });
    const e2 = p.atenderHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion', tool_input: input });
    await tick();
    await p.atenderUpdate(texto('Violeta', temas.get('s1')));
    expect(await e2).toMatchObject({ hookSpecificOutput: { updatedInput: { answers: { '¿Color?': 'Violeta' } } } });
  });

  it('volver a la PC suelta todo con {} y un botón viejo no toca la espera siguiente', async () => {
    const { p, enviados, deps } = armar();
    const e1 = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    const viejo = idDe(enviados[0].botones);
    await p.soltarTodo();
    expect(await e1).toEqual({});
    expect(deps.canal.editar).toHaveBeenCalledWith(CHAT, 1, expect.stringContaining('Retomado en la PC'));
    const e2 = p.atenderHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: {} });
    await tick();
    await p.atenderUpdate(boton(`${viejo}:si`));
    expect(deps.canal.contestarBoton).toHaveBeenCalledWith('cb', 'Ya no está vigente.');
    await p.atenderUpdate(boton(`${idDe(enviados[1].botones)}:no`));
    expect(await e2).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  });

  it('mensajes de otro usuario u otro chat se ignoran', async () => {
    const { p, temas } = armar();
    const espera = p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    await p.atenderUpdate(texto('rm -rf', temas.get('s1'), 999));
    let resuelta = false;
    espera.then(() => (resuelta = true));
    await tick();
    expect(resuelta).toBe(false);
    await p.soltarTodo();
  });

  it('un texto en General (sin tema) nunca va a una sesión: contesta la ayuda', async () => {
    const { p, enviados, deps } = armar();
    await p.atenderUpdate(texto('hola'));
    expect(deps.tomar).not.toHaveBeenCalled();
    expect(enviados.at(-1)!.texto).toContain('/estado');
  });

  it('a una sesión quieta sin espera se la toma; a una que trabaja se le guarda para su próximo Stop', async () => {
    const { p, deps, temas } = armar();
    await temas.set('s1', 901);
    await temas.set('s2', 902);
    await p.atenderUpdate(texto('seguí', 901));
    expect(deps.tomar).toHaveBeenCalledWith('s1', 'seguí');
    await p.atenderUpdate(texto('después esto', 902));
    expect(await p.atenderHook({ hook_event_name: 'Stop', session_id: 's2' })).toMatchObject({
      reason: expect.stringContaining('después esto')
    });
  });

  it('dos sesiones con el mismo nombre tienen temas distintos', async () => {
    const { p, temas } = armar({ sesiones: async () => [agente('s1'), agente('s3')] });
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's3' });
    await tick();
    await tick();
    expect(temas.get('s1')).not.toBe(temas.get('s3'));
    await p.soltarTodo();
  });

  it('vincular: sólo con el código vigente', async () => {
    const vincular = vi.fn(async () => {});
    const { p } = armar({ vinculo: () => null, vincular, codigo: () => ({ codigo: '123456', vence: Date.now() + 60_000 }) });
    await p.atenderUpdate(texto('/vincular 000000'));
    expect(vincular).not.toHaveBeenCalled();
    await p.atenderUpdate(texto('/vincular 123456'));
    expect(vincular).toHaveBeenCalledWith({ chatId: CHAT, userId: YO });
  });

  it('/fuera y /vuelvo fuerzan el modo', async () => {
    const { p, deps } = armar();
    await p.atenderUpdate(texto('/fuera'));
    await p.atenderUpdate(texto('/vuelvo'));
    expect(deps.setManual).toHaveBeenNthCalledWith(1, true);
    expect(deps.setManual).toHaveBeenNthCalledWith(2, false);
  });

  it('SessionStart devuelve el contexto siempre, esté o no fuera', async () => {
    const { p, setFuera } = armar();
    setFuera(false);
    expect(await p.atenderHook({ hook_event_name: 'SessionStart', session_id: 's1' })).toHaveProperty('hookSpecificOutput.additionalContext');
  });

  it('un tema borrado a mano se vuelve a crear', async () => {
    const { p, deps, temas, enviados } = armar();
    temas.set('s1', 555);
    const { TelegramError } = await import('./telegram');
    (deps.canal.enviar as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new TelegramError(400, 'Bad Request: message thread not found');
    });
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    expect(temas.get('s1')).not.toBe(555);
    expect(enviados.at(-1)!.tema).toBe(temas.get('s1'));
    await p.soltarTodo();
  });

  it('sin internet reintenta el envío hasta poder', async () => {
    const { p, deps, enviados } = armar();
    (deps.canal.enviar as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    void p.atenderHook({ hook_event_name: 'Stop', session_id: 's1' });
    await tick();
    await tick();
    expect(enviados).toHaveLength(1);
    await p.soltarTodo();
  });
});
```

- [ ] **Paso 2: correrlos y ver que fallan**

Run: `npx vitest run electron/puente.test.ts`
Esperado: FAIL, `Failed to resolve import "./puente"`.

- [ ] **Paso 3: implementar**

```ts
// electron/puente.ts
/**
 * El puente entre los hooks de Claude Code y Telegram (spec §5 y §6).
 *
 * Cada evento que llega con el modo fuera activo se convierte en un mensaje en
 * el tema de su sesión y en una espera que se resuelve con la respuesta del
 * usuario. Las esperas se identifican con un id corto que viaja en los botones:
 * así un botón viejo (de una espera ya soltada) no puede contestar la siguiente.
 * Los temas se asocian por `sessionId`: dos sesiones en la misma carpeta tienen
 * el mismo nombre de tema y aun así son hilos distintos.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AgenteOficina } from '../shared/types';
import {
  botonesPermiso,
  botonesPregunta,
  conImagenes,
  contextoInicio,
  leerDato,
  nombreTema,
  respuestaPermiso,
  respuestaPregunta,
  respuestaStop,
  textoFin,
  textoPermiso,
  textoPregunta,
  type Pregunta
} from './remoto-formato';
import type { EventoHook } from './remoto-servidor';
import { TelegramError, type Mensaje, type Telegram, type Update } from './telegram';

export type Canal = Pick<Telegram, 'enviar' | 'editar' | 'contestarBoton' | 'crearTema' | 'descargar'>;
export type Vinculo = { chatId: number; userId: number };
export type DepsPuente = {
  canal: Canal;
  vinculo: () => Vinculo | null;
  vincular: (v: Vinculo) => Promise<void>;
  codigo: () => { codigo: string; vence: number } | null;
  fuera: () => boolean;
  setManual: (v: boolean | null) => void;
  sesiones: () => Promise<AgenteOficina[]>;
  ultimoMensaje: (transcript: string) => Promise<string>;
  temas: {
    leer: (sessionId: string) => number | undefined;
    guardar: (sessionId: string, tema: number) => Promise<void>;
    sesionDe: (tema: number) => string | undefined;
  };
  carpetaImagenes: string;
  tomar: (sessionId: string, texto: string) => Promise<void>;
  esperaAlbumMs?: number;
};

type Espera = {
  id: string;
  sessionId: string;
  tipo: 'permiso' | 'pregunta' | 'stop';
  mensajeId: number;
  resolver: (r: object) => void;
  toolInput?: Record<string, unknown>;
  preguntas?: Pregunta[];
  marcadas?: Set<number>;
};

const AYUDA =
  'Cada sesión tiene su tema: escribí ahí para contestarle.\n/estado — cómo va cada sesión\n/fuera · /vuelvo — forzar el modo fuera';

export class Puente {
  private esperas = new Map<string, Espera>();
  /** Lo que se le escribió a una sesión que estaba trabajando: va en su próximo Stop. */
  private guardado = new Map<string, string>();
  private creandoTema = new Map<string, Promise<number>>();
  private albumes = new Map<string, { sessionId: string; texto: string; fotos: string[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(private d: DepsPuente) {}

  async atenderHook(ev: EventoHook): Promise<object> {
    if (ev.hook_event_name === 'SessionStart') return contextoInicio();
    const v = this.d.vinculo();
    if (!v || !this.d.fuera()) return {};

    if (ev.hook_event_name === 'Stop') {
      const guardado = this.guardado.get(ev.session_id);
      if (guardado !== undefined) {
        this.guardado.delete(ev.session_id);
        return respuestaStop(guardado, []);
      }
      const ultimo = ev.transcript_path ? await this.d.ultimoMensaje(ev.transcript_path).catch(() => '') : '';
      return this.esperar(ev.session_id, 'stop', textoFin(ultimo));
    }
    if (ev.hook_event_name === 'PermissionRequest') {
      return this.esperar(ev.session_id, 'permiso', textoPermiso(ev), (id) => botonesPermiso(id));
    }
    if (ev.hook_event_name === 'PreToolUse' && ev.tool_name === 'AskUserQuestion') {
      const preguntas = (ev.tool_input?.questions as Pregunta[] | undefined) ?? [];
      if (!preguntas.length) return {};
      // Una espera por pregunta sería lo ideal; AskUserQuestion casi siempre trae
      // una. ponytail: con varias se contesta sólo la primera y el resto queda vacío.
      const p = preguntas[0];
      return this.esperar(ev.session_id, 'pregunta', textoPregunta(p), (id) => botonesPregunta(id, p, new Set()), {
        toolInput: ev.tool_input,
        preguntas,
        marcadas: new Set()
      });
    }
    return {};
  }

  private async esperar(
    sessionId: string,
    tipo: Espera['tipo'],
    texto: string,
    botones?: (id: string) => ReturnType<typeof botonesPermiso>,
    extra: Partial<Espera> = {}
  ): Promise<object> {
    const id = randomBytes(4).toString('hex');
    const mensajeId = await this.enviarConReintento(sessionId, texto, botones?.(id));
    if (mensajeId === null) return {};
    return new Promise<object>((resolver) => this.esperas.set(id, { id, sessionId, tipo, mensajeId, resolver, ...extra }));
  }

  /**
   * Manda al tema de la sesión. Un tema borrado a mano se recrea una vez. Sin
   * red se reintenta con espera creciente (hasta 60 s) mientras siga el modo
   * fuera; si el usuario vuelve, devuelve null y la terminal se encarga.
   */
  private async enviarConReintento(sessionId: string, texto: string, botones?: ReturnType<typeof botonesPermiso>): Promise<number | null> {
    const v = this.d.vinculo()!;
    for (let intento = 0; ; intento++) {
      try {
        const tema = await this.temaDe(sessionId);
        return await this.d.canal.enviar(v.chatId, texto, { tema, botones });
      } catch (e) {
        if (e instanceof TelegramError && e.codigo === 400 && /thread/i.test(e.message) && intento === 0) {
          await this.d.temas.borrar(sessionId);
          continue;
        }
        if (e instanceof TelegramError) throw e;
        await new Promise((r) => setTimeout(r, Math.min(60_000, (this.d.esperaReintentoMs ?? 1000) * 2 ** intento)));
        if (!this.d.fuera()) return null;
      }
    }
  }

  private resolver(e: Espera, r: object): void {
    this.esperas.delete(e.id);
    e.resolver(r);
  }

  /** El tema de una sesión, creándolo la primera vez. Dos pedidos a la vez comparten la creación. */
  private async temaDe(sessionId: string): Promise<number | undefined> {
    const ya = this.d.temas.leer(sessionId);
    if (ya) return ya;
    let enCurso = this.creandoTema.get(sessionId);
    if (!enCurso) {
      enCurso = (async () => {
        const a = (await this.d.sesiones()).find((s) => s.sessionId === sessionId);
        const tema = await this.d.canal.crearTema(this.d.vinculo()!.chatId, a ? nombreTema(a) : sessionId.slice(0, 8));
        await this.d.temas.guardar(sessionId, tema);
        return tema;
      })().finally(() => this.creandoTema.delete(sessionId));
      this.creandoTema.set(sessionId, enCurso);
    }
    return enCurso;
  }

  async soltarTodo(): Promise<void> {
    const v = this.d.vinculo();
    for (const e of [...this.esperas.values()]) {
      this.resolver(e, {});
      if (v) await this.d.canal.editar(v.chatId, e.mensajeId, '✋ Retomado en la PC.').catch(() => {});
    }
  }

  async atenderUpdate(u: Update): Promise<void> {
    const v = this.d.vinculo();
    if (u.callback_query) {
      const cb = u.callback_query;
      if (!v || cb.from.id !== v.userId) return;
      const dato = leerDato(cb.data ?? '');
      const e = dato && this.esperas.get(dato.id);
      if (!dato || !e) return void (await this.d.canal.contestarBoton(cb.id, 'Ya no está vigente.'));
      await this.d.canal.contestarBoton(cb.id);
      if (e.tipo === 'permiso') return this.resolver(e, respuestaPermiso(dato.accion === 'si'));
      if (e.tipo === 'pregunta') return this.botonPregunta(e, dato.accion);
      return;
    }
    const m = u.message;
    if (!m) return;
    if (!v) return this.intentarVincular(m);
    if (m.chat.id !== v.chatId || m.from?.id !== v.userId) return;
    const texto = (m.text ?? m.caption ?? '').trim();
    if (texto === '/fuera' || texto.startsWith('/fuera@')) return this.d.setManual(true);
    if (texto === '/vuelvo' || texto.startsWith('/vuelvo@')) return this.d.setManual(false);
    const sessionId = m.is_topic_message && m.message_thread_id ? this.d.temas.sesionDe(m.message_thread_id) : undefined;
    if (texto.startsWith('/estado')) return this.estado(v, m.message_thread_id, sessionId);
    if (!sessionId) return void (await this.d.canal.enviar(v.chatId, AYUDA, { tema: m.message_thread_id }));
    if (m.photo?.length) return this.foto(sessionId, m, texto);
    return this.aSesion(sessionId, texto, []);
  }

  private async botonPregunta(e: Espera, accion: string): Promise<void> {
    const p = e.preguntas![0];
    const respuestas = (valor: string) => this.resolver(e, respuestaPregunta(e.toolInput!, { [p.question]: valor }));
    if (accion === 'listo') return respuestas([...e.marcadas!].sort().map((i) => p.options[i].label).join(', '));
    const i = Number(accion.slice(1));
    if (!p.options[i]) return;
    if (!p.multiSelect) return respuestas(p.options[i].label);
    if (e.marcadas!.has(i)) e.marcadas!.delete(i);
    else e.marcadas!.add(i);
    // Telegram no deja cambiar sólo los botones con `editar`; se manda de nuevo.
    const v = this.d.vinculo()!;
    await this.d.canal.editar(v.chatId, e.mensajeId, textoPregunta(p)).catch(() => {});
    e.mensajeId = await this.d.canal.enviar(v.chatId, 'Marcadas:', {
      tema: this.d.temas.leer(e.sessionId),
      botones: botonesPregunta(e.id, p, e.marcadas!)
    });
  }

  /** Lo escrito en el tema de una sesión: responde lo que esté esperando, y si no, la toma o lo guarda. */
  private async aSesion(sessionId: string, texto: string, imagenes: string[]): Promise<void> {
    const pendientes = [...this.esperas.values()].filter((e) => e.sessionId === sessionId);
    const pregunta = pendientes.find((e) => e.tipo === 'pregunta');
    if (pregunta && texto) return this.resolver(pregunta, respuestaPregunta(pregunta.toolInput!, { [pregunta.preguntas![0].question]: texto }));
    const stop = pendientes.find((e) => e.tipo === 'stop');
    if (stop) return this.resolver(stop, respuestaStop(texto, imagenes));
    const a = (await this.d.sesiones()).find((s) => s.sessionId === sessionId);
    const v = this.d.vinculo()!;
    const tema = this.d.temas.leer(sessionId);
    if (!a) return void (await this.d.canal.enviar(v.chatId, 'Esa sesión terminó.', { tema }));
    // Tomada, la sesión recibe el texto como un prompt común (no como feedback de hook): va sin prefijo.
    if (a.estado === 'esperando') return this.d.tomar(sessionId, conImagenes(texto, imagenes));
    this.guardado.set(sessionId, [this.guardado.get(sessionId), texto].filter(Boolean).join('\n'));
    await this.d.canal.enviar(v.chatId, 'Está trabajando: se lo paso apenas termine este turno.', { tema });
  }

  /** Las fotos de un álbum llegan en mensajes separados: se juntan un momento y van en uno. */
  private async foto(sessionId: string, m: Mensaje, texto: string): Promise<void> {
    const mayor = m.photo!.at(-1)!;
    const ruta = await this.d.canal.descargar(mayor.file_id, join(this.d.carpetaImagenes, sessionId, `${Date.now()}-${m.message_id}.jpg`));
    const clave = m.media_group_id ?? `solo-${m.message_id}`;
    const album = this.albumes.get(clave);
    if (album) {
      album.fotos.push(ruta);
      if (texto) album.texto = texto;
      return;
    }
    const nuevo = {
      sessionId,
      texto,
      fotos: [ruta],
      timer: setTimeout(() => {
        this.albumes.delete(clave);
        void this.aSesion(nuevo.sessionId, nuevo.texto || 'Mirá las imágenes.', nuevo.fotos);
      }, this.d.esperaAlbumMs ?? 2000)
    };
    this.albumes.set(clave, nuevo);
  }

  private async estado(v: Vinculo, tema: number | undefined, sessionId: string | undefined): Promise<void> {
    const todas = await this.d.sesiones();
    const ETIQUETA: Record<string, string> = {
      escribiendo: '🛠 trabajando', leyendo: '🛠 trabajando', delegando: '👥 delegando', pensando: '💭 pensando',
      permiso: '🔐 pide permiso', esperando: '⏸ te espera'
    };
    const linea = (a: AgenteOficina) =>
      `${nombreTema(a)}\n   ${ETIQUETA[a.estado] ?? a.estado}${a.herramienta ? ` · ${a.herramienta}: ${a.detalle}` : ''}` +
      (this.esperas.size && [...this.esperas.values()].some((e) => e.sessionId === a.sessionId) ? ' · esperando tu respuesta acá' : '');
    const texto = sessionId
      ? (() => {
          const a = todas.find((s) => s.sessionId === sessionId);
          if (!a) return 'Esa sesión terminó.';
          const subs = a.subagentes.filter((s) => s.estado !== 'terminado').map((s) => `   ↳ ${s.nombrePropio || s.tipoAgente}`);
          return [linea(a), ...subs].join('\n');
        })()
      : todas.length
        ? todas.map(linea).join('\n\n')
        : 'No hay sesiones abiertas.';
    await this.d.canal.enviar(v.chatId, texto, { tema });
  }

  private async intentarVincular(m: Mensaje): Promise<void> {
    const c = this.d.codigo();
    const pedido = /^\/vincular(?:@\S+)?\s+(\d{6})$/.exec((m.text ?? '').trim());
    if (!c || !pedido || !m.from || Date.now() > c.vence || pedido[1] !== c.codigo) return;
    await this.d.vincular({ chatId: m.chat.id, userId: m.from.id });
    await this.d.canal.enviar(m.chat.id, `Listo: quedó vinculado.\n\n${AYUDA}`, { tema: m.message_thread_id });
  }
}
```

- [ ] **Paso 4: correrlos y ver que pasan**

Run: `npx vitest run electron/puente.test.ts`
Esperado: PASS (14 tests).

- [ ] **Paso 5: commit**

```bash
git add electron/puente.ts electron/puente.test.ts
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega el puente que convierte permisos, preguntas y fin de turno en mensajes por tema y devuelve la respuesta al hook.
- Se agregan la vinculación con código, los comandos /estado, /fuera y /vuelvo, y el envío de imágenes.
- Se sueltan las esperas al volver a la PC y se invalidan los botones viejos.
EOF
)"
```

---

### Tarea 7: tomar sesiones quietas (`tomar.ts`)

**Archivos:**
- Crear: `electron/tomar.ts`
- Modificar: `electron/oficina.ts` (exportar `iniciosDeProceso`, cerca de la línea 488)
- Test: `electron/tomar.test.ts`

**Interfaces:**
- Consume: `sessionEnv(base, configDir)` de `electron/terminal.ts`; `mismoInicio`, `iniciosDeProceso` de `electron/oficina.ts`.
- Produce:
  - `argsTurno(sessionId: string, mensaje: string): string[]` → `['-p', '--chrome', '--resume', id, '--output-format', 'stream-json', '--verbose', mensaje]`
  - `textosDe(linea: string): string[]` (bloques `text` de una línea `stream-json` de tipo `assistant`)
  - `type Registro = { pid: number; procStart?: string; configDir: string; cwd: string }`
  - `class Tomador` con `constructor(d: { registro: (sessionId: string) => Promise<Registro | null>; matar: (pid: number, procStart?: string) => Promise<void>; lanzar: (args: string[], op: { cwd: string; env: NodeJS.ProcessEnv }) => { stdout: NodeJS.ReadableStream; fin: Promise<number> }; alTexto: (sessionId: string, texto: string) => void; alError: (sessionId: string, error: string) => void })`, `enviar(sessionId, mensaje): Promise<void>`, `tomadas(): string[]`, `soltar(sessionId): void`
  - `matarSiEsElMismo(pid: number, procStart?: string): Promise<void>`
  - `citarParaShell(s: string): string`
  - `lanzarClaude(args, op)`

- [ ] **Paso 1: exportar `iniciosDeProceso`**

En `electron/oficina.ts`, cambiar `async function iniciosDeProceso(` por `export async function iniciosDeProceso(`.

- [ ] **Paso 2: escribir los tests que fallan**

```ts
// electron/tomar.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { argsTurno, citarParaShell, textosDe, Tomador } from './tomar';

describe('argsTurno', () => {
  it('reanuda sin terminal, con Chrome y salida por líneas', () => {
    expect(argsTurno('abc', 'seguí')).toEqual(['-p', '--chrome', '--resume', 'abc', '--output-format', 'stream-json', '--verbose', 'seguí']);
  });
  it('cita el mensaje para cmd', () => {
    expect(citarParaShell('corré "npm test" ya')).toBe('"corré \\"npm test\\" ya"');
  });
});

describe('textosDe', () => {
  it('saca el texto del asistente y nada más', () => {
    const l = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hola' }, { type: 'tool_use', name: 'Bash' }] } });
    expect(textosDe(l)).toEqual(['Hola']);
    expect(textosDe(JSON.stringify({ type: 'system' }))).toEqual([]);
    expect(textosDe('no es json')).toEqual([]);
  });
});

describe('Tomador', () => {
  function armar() {
    const lanzados: Array<{ args: string[]; env: NodeJS.ProcessEnv; salida: PassThrough; terminar: (c: number) => void }> = [];
    const d = {
      registro: vi.fn(async () => ({ pid: 77, procStart: '1', configDir: 'C:/cfg', cwd: 'C:/repo' })),
      matar: vi.fn(async () => {}),
      lanzar: vi.fn((args: string[], op: { cwd: string; env: NodeJS.ProcessEnv }) => {
        const salida = new PassThrough();
        let terminar!: (c: number) => void;
        const fin = new Promise<number>((r) => (terminar = r));
        lanzados.push({ args, env: op.env, salida, terminar });
        return { stdout: salida, fin };
      }),
      alTexto: vi.fn(),
      alError: vi.fn()
    };
    return { t: new Tomador(d), d, lanzados };
  }

  it('la primera vez cierra el claude de la terminal; después sólo manda turnos', async () => {
    const { t, d, lanzados } = armar();
    const p1 = t.enviar('abc', 'uno');
    await new Promise((r) => setTimeout(r, 0));
    expect(d.matar).toHaveBeenCalledWith(77, '1');
    expect(lanzados[0].env.CLAUDE_MONITOR_TOMADA).toBe('1');
    expect(lanzados[0].env.CLAUDE_CONFIG_DIR).toBe('C:/cfg');
    lanzados[0].salida.end(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hecho' }] } }) + '\n');
    lanzados[0].terminar(0);
    await p1;
    expect(d.alTexto).toHaveBeenCalledWith('abc', 'Hecho');
    await Promise.all([t.enviar('abc', 'dos'), (async () => {
      await new Promise((r) => setTimeout(r, 0));
      lanzados[1].salida.end();
      lanzados[1].terminar(0);
    })()]);
    expect(d.matar).toHaveBeenCalledTimes(1);
    expect(t.tomadas()).toEqual(['abc']);
  });

  it('no corre dos turnos a la vez sobre la misma sesión', async () => {
    const { t, lanzados } = armar();
    const p1 = t.enviar('abc', 'uno');
    const p2 = t.enviar('abc', 'dos');
    await new Promise((r) => setTimeout(r, 0));
    expect(lanzados).toHaveLength(1);
    lanzados[0].salida.end();
    lanzados[0].terminar(0);
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    expect(lanzados).toHaveLength(2);
    lanzados[1].salida.end();
    lanzados[1].terminar(0);
    await p2;
  });

  it('un turno que sale con error se avisa', async () => {
    const { t, d, lanzados } = armar();
    const p = t.enviar('abc', 'uno');
    await new Promise((r) => setTimeout(r, 0));
    lanzados[0].salida.end();
    lanzados[0].terminar(1);
    await p;
    expect(d.alError).toHaveBeenCalledWith('abc', expect.stringContaining('1'));
  });
});
```

- [ ] **Paso 3: correrlos y ver que fallan**

Run: `npx vitest run electron/tomar.test.ts`
Esperado: FAIL, `Failed to resolve import "./tomar"`.

- [ ] **Paso 4: implementar**

```ts
// electron/tomar.ts
/**
 * Tomar una sesión quieta (spec §6). Una sesión que terminó su turno antes del
 * modo fuera no está en ninguna espera de Stop, así que un mensaje desde
 * Telegram no tiene por dónde entrar. La app cierra el `claude` de su terminal
 * (quieto en el prompt: todo está en el transcript) y sigue con
 * `claude -p --resume`, un turno por mensaje, nunca dos a la vez.
 *
 * `CLAUDE_MONITOR_TOMADA=1` hace que el hook no espere en el Stop de estos
 * turnos: esperar trabaría el proceso `-p` (ver `hooks/remoto-hook.js`).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { iniciosDeProceso, mismoInicio } from './oficina';
import { sessionEnv } from './terminal';

export const argsTurno = (sessionId: string, mensaje: string) => [
  '-p', '--chrome', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', mensaje
];

export function textosDe(linea: string): string[] {
  try {
    const e = JSON.parse(linea) as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
    if (e.type !== 'assistant') return [];
    return (e.message?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text!);
  } catch {
    return [];
  }
}

export type Registro = { pid: number; procStart?: string; configDir: string; cwd: string };
type Lanzar = (args: string[], op: { cwd: string; env: NodeJS.ProcessEnv }) => { stdout: NodeJS.ReadableStream; fin: Promise<number> };

export class Tomador {
  private cola = new Map<string, Promise<void>>();
  private registros = new Map<string, Registro>();

  constructor(
    private d: {
      registro: (sessionId: string) => Promise<Registro | null>;
      matar: (pid: number, procStart?: string) => Promise<void>;
      lanzar: Lanzar;
      alTexto: (sessionId: string, texto: string) => void;
      alError: (sessionId: string, error: string) => void;
    }
  ) {}

  tomadas(): string[] {
    return [...this.registros.keys()];
  }

  /** La sesión volvió a la terminal (Reabrir): deja de estar tomada. */
  soltar(sessionId: string): void {
    this.registros.delete(sessionId);
  }

  enviar(sessionId: string, mensaje: string): Promise<void> {
    const antes = this.cola.get(sessionId) ?? Promise.resolve();
    const turno = antes.then(() => this.turno(sessionId, mensaje)).catch((e) => this.d.alError(sessionId, String(e?.message ?? e)));
    this.cola.set(sessionId, turno);
    return turno;
  }

  private async turno(sessionId: string, mensaje: string): Promise<void> {
    let reg = this.registros.get(sessionId);
    if (!reg) {
      const vivo = await this.d.registro(sessionId);
      if (!vivo) throw new Error('No encontré la sesión abierta para tomarla.');
      await this.d.matar(vivo.pid, vivo.procStart);
      reg = vivo;
      this.registros.set(sessionId, reg);
    }
    const env = { ...sessionEnv(process.env, reg.configDir), CLAUDE_MONITOR_TOMADA: '1' };
    const { stdout, fin } = this.d.lanzar(argsTurno(sessionId, mensaje), { cwd: reg.cwd, env });
    for await (const linea of createInterface({ input: stdout })) {
      for (const t of textosDe(linea)) this.d.alTexto(sessionId, t);
    }
    const codigo = await fin;
    if (codigo !== 0) this.d.alError(sessionId, `claude -p terminó con código ${codigo}.`);
  }
}

/** Cierra el pid sólo si es el mismo proceso que anotó el registro (los pid se reciclan). */
export async function matarSiEsElMismo(pid: number, procStart?: string): Promise<void> {
  const inicios = await iniciosDeProceso([pid], Date.now());
  if (procStart && !mismoInicio(procStart, inicios.get(pid))) throw new Error('El proceso de esa sesión ya no es el que era.');
  process.kill(pid);
  // Claude Code borra su `sessions/<pid>.json` al cerrar bien; matado no, y no hace falta: se lo ignora por muerto.
}

/** `cmd.exe` parte por espacios: el mensaje va entre comillas y con las suyas escapadas. */
export const citarParaShell = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/**
 * `shell: true` porque en Windows `claude` puede ser `claude.cmd` (npm) o
 * `claude.exe` (instalador nativo) y sin shell el `.cmd` no arranca. Por eso el
 * mensaje, que es el último argumento, va citado.
 */
export function lanzarClaude(args: string[], op: { cwd: string; env: NodeJS.ProcessEnv }) {
  const citados = args.map((a, i) => (i === args.length - 1 ? citarParaShell(a) : a));
  const hijo = spawn('claude', citados, { cwd: op.cwd, env: op.env, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const fin = new Promise<number>((ok) => {
    hijo.on('exit', (c) => ok(c ?? 1));
    hijo.on('error', () => ok(1));
  });
  return { stdout: hijo.stdout!, fin };
}
```

- [ ] **Paso 5: correrlos y ver que pasan**

Run: `npx vitest run electron/tomar.test.ts electron/oficina.test.ts`
Esperado: PASS.

- [ ] **Paso 6: commit**

```bash
git add electron/tomar.ts electron/tomar.test.ts electron/oficina.ts
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega la toma de sesiones quietas, que siguen sin terminal con claude -p --chrome --resume, un turno a la vez.
EOF
)"
```

---

### Tarea 8: instalar y sacar el hook (`remoto-instalar.ts`)

**Archivos:**
- Crear: `electron/remoto-instalar.ts`
- Test: `electron/remoto-instalar.test.ts`

**Interfaces:**
- Consume: `syncAllPlugins()` y `getSharedRoot()` de `electron/profiles.ts`.
- Produce:
  - `EVENTOS: Array<[evento: string, matcher: string]>` = `[['PermissionRequest','*'],['PreToolUse','AskUserQuestion'],['Stop','*'],['SessionStart','*']]`
  - `conHook(raw: string, comando: string): string | null` (null si ya estaba igual)
  - `sinHook(raw: string): string | null`
  - `instalarHook(fuente: string, destino: string): Promise<void>` (copia el script, lo agrega al pozo y sincroniza)
  - `sacarHook(): Promise<void>`

- [ ] **Paso 1: escribir los tests que fallan**

```ts
// electron/remoto-instalar.test.ts
import { describe, it, expect } from 'vitest';
import { conHook, sinHook } from './remoto-instalar';

const CMD = 'node "C:/x/remoto-hook.js"';

describe('conHook / sinHook', () => {
  it('agrega los cuatro eventos sin tocar los hooks ajenos', () => {
    const raw = JSON.stringify({ model: 'opus', hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'otro' }] }] } });
    const s = JSON.parse(conHook(raw, CMD)!);
    expect(s.model).toBe('opus');
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('otro');
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CMD, timeout: 86400 }] }]);
    expect(Object.keys(s.hooks).sort()).toEqual(['PermissionRequest', 'PreToolUse', 'SessionStart', 'Stop']);
  });
  it('es idempotente', () => {
    const una = conHook('{}', CMD)!;
    expect(conHook(una, CMD)).toBeNull();
  });
  it('sacarlo deja sólo lo ajeno y borra los eventos vacíos', () => {
    const raw = conHook(JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'otro' }] }] } }), CMD)!;
    const s = JSON.parse(sinHook(raw)!);
    expect(s.hooks).toEqual({ Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'otro' }] }] });
  });
  it('un settings.json ilegible no se toca', () => {
    expect(conHook('{roto', CMD)).toBeNull();
    expect(sinHook('{roto')).toBeNull();
  });
});
```

- [ ] **Paso 2: correrlos y ver que fallan**

Run: `npx vitest run electron/remoto-instalar.test.ts`
Esperado: FAIL, `Failed to resolve import "./remoto-instalar"`.

- [ ] **Paso 3: implementar**

```ts
// electron/remoto-instalar.ts
/**
 * El hook del puente de Telegram en `settings.json`. Va en el del pozo (la
 * cuenta principal) y de ahí lo reparte `syncAllPlugins`: `syncPlugins` pisa la
 * clave `hooks` de cada cuenta con la del pozo (`PLUGIN_KEYS` en plugins.ts), así
 * que instalarlo cuenta por cuenta no duraría. Las entradas propias se
 * reconocen por el nombre del script; las demás no se tocan.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getSharedRoot, syncAllPlugins } from './profiles';

export const EVENTOS: Array<[string, string]> = [
  ['PermissionRequest', '*'],
  ['PreToolUse', 'AskUserQuestion'],
  ['Stop', '*'],
  ['SessionStart', '*']
];

type Entrada = { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> };
type Settings = { hooks?: Record<string, Entrada[]> } & Record<string, unknown>;

const esNuestra = (e: Entrada) => (e.hooks ?? []).some((h) => (h.command ?? '').includes('remoto-hook.js'));

function leer(raw: string): Settings | null {
  try {
    const s = JSON.parse(raw) as Settings;
    return typeof s === 'object' && s !== null ? s : null;
  } catch {
    return null;
  }
}

export function sinHook(raw: string): string | null {
  const s = leer(raw);
  if (!s) return null;
  const hooks = s.hooks ?? {};
  let cambio = false;
  for (const ev of Object.keys(hooks)) {
    const quedan = (hooks[ev] ?? []).filter((e) => !esNuestra(e));
    if (quedan.length === hooks[ev].length) continue;
    cambio = true;
    if (quedan.length) hooks[ev] = quedan;
    else delete hooks[ev];
  }
  if (!cambio) return null;
  s.hooks = hooks;
  return `${JSON.stringify(s, null, 2)}\n`;
}

export function conHook(raw: string, comando: string): string | null {
  const s = leer(raw);
  if (!s) return null;
  const limpio = leer(sinHook(raw) ?? raw)!;
  const hooks = limpio.hooks ?? {};
  for (const [ev, matcher] of EVENTOS) {
    hooks[ev] = [...(hooks[ev] ?? []), { matcher, hooks: [{ type: 'command', command: comando, timeout: 86400 }] }];
  }
  limpio.hooks = hooks;
  const salida = `${JSON.stringify(limpio, null, 2)}\n`;
  return JSON.stringify(leer(salida)) === JSON.stringify(s) ? null : salida;
}

async function editarPozo(cambiar: (raw: string) => string | null): Promise<void> {
  const archivo = join(await getSharedRoot(), 'settings.json');
  const raw = await readFile(archivo, 'utf8').catch(() => '{}');
  const nuevo = cambiar(raw);
  if (nuevo !== null) await writeFile(archivo, nuevo, 'utf8');
  await syncAllPlugins();
}

export async function instalarHook(fuente: string, destino: string): Promise<void> {
  await mkdir(dirname(destino), { recursive: true });
  await copyFile(fuente, destino);
  await editarPozo((raw) => conHook(raw, `node "${destino.split('\\').join('/')}"`));
}

export const sacarHook = () => editarPozo(sinHook);
```

- [ ] **Paso 4: correrlos y ver que pasan**

Run: `npx vitest run electron/remoto-instalar.test.ts`
Esperado: PASS (4 tests).

- [ ] **Paso 5: commit**

```bash
git add electron/remoto-instalar.ts electron/remoto-instalar.test.ts
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega la instalación del hook del puente en la cuenta principal, que se reparte a las demás con la sincronización de plugins.
EOF
)"
```

---

### Tarea 9: configuración guardada (`remoto-config.ts`)

**Archivos:**
- Crear: `electron/remoto-config.ts`
- Test: `electron/remoto-config.test.ts`

**Interfaces:**
- Produce:
  - `type ConfigRemoto = { activo: boolean; token: string; chatId: number | null; userId: number | null; umbralMin: number; offset: number; temas: Record<string, number> }` (en disco `token` va cifrado en base64)
  - `type Cifrador = { cifrar: (t: string) => Buffer; descifrar: (b: Buffer) => string }`
  - `leerConfig(archivo: string, c: Cifrador): Promise<ConfigRemoto>`
  - `guardarConfig(archivo: string, cfg: ConfigRemoto, c: Cifrador): Promise<void>`
  - `CONFIG_INICIAL: ConfigRemoto` (`activo: false`, `umbralMin: 10`)
  - `nuevoCodigo(ahora?: number): { codigo: string; vence: number }` (6 dígitos, 10 minutos)
  - `borrarViejas(carpeta: string, maxMs: number, ahora?: number): Promise<number>` (borra los archivos más viejos que `maxMs` en las subcarpetas; devuelve cuántos)

- [ ] **Paso 1: escribir los tests que fallan**

```ts
// electron/remoto-config.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { borrarViejas, CONFIG_INICIAL, guardarConfig, leerConfig, nuevoCodigo } from './remoto-config';

const falso = { cifrar: (t: string) => Buffer.from(`X${t}`), descifrar: (b: Buffer) => b.toString().slice(1) };
let dir = '';
afterEach(async () => dir && rm(dir, { recursive: true, force: true }));

describe('remoto-config', () => {
  it('sin archivo da la configuración inicial, apagada', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    expect(await leerConfig(join(dir, 't.json'), falso)).toEqual(CONFIG_INICIAL);
    expect(CONFIG_INICIAL.activo).toBe(false);
  });
  it('el token no queda en claro en disco y vuelve igual', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const f = join(dir, 't.json');
    await guardarConfig(f, { ...CONFIG_INICIAL, token: '123:ABC', chatId: -5, userId: 9, temas: { s: 3 } }, falso);
    expect(await readFile(f, 'utf8')).not.toContain('123:ABC');
    expect(await leerConfig(f, falso)).toMatchObject({ token: '123:ABC', chatId: -5, userId: 9, temas: { s: 3 } });
  });
  it('el código es de 6 dígitos y vence a los 10 minutos', () => {
    const c = nuevoCodigo(1000);
    expect(c.codigo).toMatch(/^\d{6}$/);
    expect(c.vence).toBe(1000 + 10 * 60_000);
  });
  it('borra sólo las imágenes viejas', async () => {
    dir = await mkdtemp(join(tmpdir(), 'img-'));
    await mkdir(join(dir, 's1'));
    const vieja = join(dir, 's1', 'a.jpg');
    const nueva = join(dir, 's1', 'b.jpg');
    await writeFile(vieja, 'x');
    await writeFile(nueva, 'x');
    const hace8dias = new Date(Date.now() - 8 * 86_400_000);
    await utimes(vieja, hace8dias, hace8dias);
    expect(await borrarViejas(dir, 7 * 86_400_000)).toBe(1);
    expect(existsSync(vieja)).toBe(false);
    expect(existsSync(nueva)).toBe(true);
  });
});
```

- [ ] **Paso 2: correrlos y ver que fallan**

Run: `npx vitest run electron/remoto-config.test.ts`
Esperado: FAIL, `Failed to resolve import "./remoto-config"`.

- [ ] **Paso 3: implementar**

```ts
// electron/remoto-config.ts
/**
 * La configuración del puente de Telegram en `%APPDATA%\claude-monitor\telegram.json`.
 * El token del bot va cifrado (en la app, con `safeStorage` de Electron): quien
 * tenga el token puede mandar mensajes como el bot y leer lo que le llega.
 */

import { randomInt } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ConfigRemoto = {
  activo: boolean;
  token: string;
  chatId: number | null;
  userId: number | null;
  umbralMin: number;
  offset: number;
  temas: Record<string, number>;
};
export type Cifrador = { cifrar: (t: string) => Buffer; descifrar: (b: Buffer) => string };

export const CONFIG_INICIAL: ConfigRemoto = { activo: false, token: '', chatId: null, userId: null, umbralMin: 10, offset: 0, temas: {} };

export async function leerConfig(archivo: string, c: Cifrador): Promise<ConfigRemoto> {
  try {
    const { tokenCifrado, ...d } = JSON.parse(await readFile(archivo, 'utf8')) as Partial<ConfigRemoto> & { tokenCifrado?: string };
    const token = tokenCifrado ? c.descifrar(Buffer.from(tokenCifrado, 'base64')) : '';
    return { ...CONFIG_INICIAL, ...d, token, temas: d.temas ?? {} };
  } catch {
    return { ...CONFIG_INICIAL, temas: {} };
  }
}

export async function guardarConfig(archivo: string, cfg: ConfigRemoto, c: Cifrador): Promise<void> {
  const { token, ...resto } = cfg;
  const datos = { ...resto, tokenCifrado: token ? c.cifrar(token).toString('base64') : '' };
  await mkdir(dirname(archivo), { recursive: true });
  const tmp = `${archivo}.tmp`;
  await writeFile(tmp, JSON.stringify(datos, null, 2), 'utf8');
  await rename(tmp, archivo);
}

export const nuevoCodigo = (ahora = Date.now()) => ({
  codigo: String(randomInt(0, 1_000_000)).padStart(6, '0'),
  vence: ahora + 10 * 60_000
});

/** Las imágenes que llegaron por Telegram no se guardan para siempre (spec §8: 7 días). */
export async function borrarViejas(carpeta: string, maxMs: number, ahora = Date.now()): Promise<number> {
  let borradas = 0;
  for (const sub of await readdir(carpeta).catch(() => [] as string[])) {
    for (const f of await readdir(join(carpeta, sub)).catch(() => [] as string[])) {
      const ruta = join(carpeta, sub, f);
      const s = await stat(ruta).catch(() => null);
      if (s?.isFile() && ahora - s.mtimeMs > maxMs) {
        await rm(ruta, { force: true });
        borradas++;
      }
    }
  }
  return borradas;
}
```

- [ ] **Paso 4: correrlos y ver que pasan**

Run: `npx vitest run electron/remoto-config.test.ts`
Esperado: PASS (4 tests).

- [ ] **Paso 5: commit**

```bash
git add electron/remoto-config.ts electron/remoto-config.test.ts
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega la configuración guardada del puente de Telegram, con el token cifrado y el código de vinculación.
- Se borran las imágenes recibidas por Telegram después de 7 días.
EOF
)"
```

---

### Tarea 10: armado, ciclo de vida e IPC (`remoto.ts`)

**Archivos:**
- Crear: `electron/remoto.ts`
- Modificar: `electron/main.ts` (registrar IPC, arrancar y detener con la app)
- Modificar: `electron/preload.ts`, `shared/types.ts`
- Modificar: `package.json` (`extraResources` del hook y el ayudante)

**Interfaces:**
- Consume: todo lo anterior; `agentesVivos`, `conversacionDe` de `oficina.ts`; `allProfiles` de `profiles.ts`; `leerNombres` de `nombres.ts`; `anotar` de `registro.ts`.
- Produce (en `shared/types.ts`):
  ```ts
  export type EstadoTelegram = {
    activo: boolean;
    bot: string;           // @usuario del bot, '' si no hay token válido
    vinculado: boolean;
    codigo: string;        // el código vigente para /vincular, '' si no hay
    umbralMin: number;
    fuera: boolean;
    motivo: 'manual' | 'tapa' | 'inactividad' | null;
    tomadas: string[];     // sessionIds continuadas desde Telegram
    error: string;         // último error visible ('' si ninguno)
  };
  ```
  y en `ClaudeMonitorApi`:
  ```ts
  telegramEstado: () => Promise<Result<EstadoTelegram>>;
  telegramToken: (token: string) => Promise<Result<EstadoTelegram>>;
  telegramVincular: () => Promise<Result<EstadoTelegram>>;
  telegramActivar: (activo: boolean) => Promise<Result<EstadoTelegram>>;
  telegramUmbral: (minutos: number) => Promise<Result<EstadoTelegram>>;
  telegramFuera: (fuera: boolean | null) => Promise<Result<EstadoTelegram>>;
  telegramReabrir: (sessionId: string) => Promise<Result<null>>;
  ```
- Produce (en `electron/remoto.ts`): `iniciarRemoto(): Promise<void>`, `detenerRemoto(): Promise<void>`, `registrarIpcRemoto(handle, reanudar: (sessionId: string) => Promise<void>)`.

- [ ] **Paso 1: agregar los tipos**

En `shared/types.ts`, agregar `EstadoTelegram` (arriba) después de `Conversacion`, y los siete métodos al final de `ClaudeMonitorApi`, antes de la llave de cierre.

- [ ] **Paso 2: implementar `remoto.ts`**

```ts
// electron/remoto.ts
/**
 * Arma el puente de Telegram con las piezas de `telegram.ts`, `puente.ts`,
 * `presencia.ts`, `tomar.ts` y `remoto-servidor.ts`, y lo conecta con la app:
 * arranca y se detiene con ella, y responde el IPC de la sección de
 * configuración (`src/TelegramPanel.tsx`). Spec:
 * `docs/superpowers/specs/2026-09-28-telegram-remoto-design.md`.
 */

import { app, powerMonitor, safeStorage } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EstadoTelegram } from '../shared/types';
import { agentesVivos, conversacionDe } from './oficina';
import { leerNombres } from './nombres';
import { Presencia, lanzarAyudanteTapa } from './presencia';
import { allProfiles } from './profiles';
import { Puente } from './puente';
import { anotar } from './registro';
import { borrarViejas, CONFIG_INICIAL, guardarConfig, leerConfig, nuevoCodigo, type ConfigRemoto } from './remoto-config';
import { instalarHook, sacarHook } from './remoto-instalar';
import { iniciarServidor } from './remoto-servidor';
import { Telegram, TelegramError } from './telegram';
import { lanzarClaude, matarSiEsElMismo, Tomador } from './tomar';

const appdata = () => process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const ARCHIVO_CONFIG = () => join(appdata(), 'claude-monitor', 'telegram.json');
const ARCHIVO_ENDPOINT = () => join(appdata(), 'claude-monitor', 'remoto.json');
const DESTINO_HOOK = () => join(appdata(), 'claude-monitor', 'hooks', 'remoto-hook.js');
const IMAGENES = () => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'claude-monitor', 'telegram');
const recurso = (nombre: string) =>
  app.isPackaged ? join(process.resourcesPath, 'remoto', nombre) : join(app.getAppPath(), 'electron', nombre);

const cifrador = {
  cifrar: (t: string) => safeStorage.encryptString(t),
  descifrar: (b: Buffer) => safeStorage.decryptString(b)
};

let cfg: ConfigRemoto = { ...CONFIG_INICIAL };
let bot = '';
let error = '';
let codigo: { codigo: string; vence: number } | null = null;
let señal: AbortController | null = null;
let cerrarServidor: (() => Promise<void>) | null = null;
let cerrarTapa: (() => void) | null = null;
let revisarPresencia: ReturnType<typeof setInterval> | null = null;
let puente: Puente | null = null;
let tg: Telegram | null = null;
const guardar = () => guardarConfig(ARCHIVO_CONFIG(), cfg, cifrador);

const presencia = new Presencia(
  () => powerMonitor.getSystemIdleTime(),
  CONFIG_INICIAL.umbralMin,
  (e) => {
    anotar('telegram: modo fuera', { fuera: e.fuera, motivo: e.motivo });
    if (!e.fuera) void puente?.soltarTodo();
  }
);

async function sesionesConNombre() {
  const [agentes, nombres] = await Promise.all([agentesVivos((await allProfiles()).profiles), leerNombres()]);
  return agentes.map((a) => ({ ...a, nombre: nombres[a.sessionId]?.nombre || a.nombre }));
}

async function ultimoMensaje(transcript: string): Promise<string> {
  const c = await conversacionDe(transcript);
  return [...c.items].reverse().find((i) => i.tipo === 'claude')?.texto ?? '';
}

const tomador = new Tomador({
  registro: async (sessionId) => {
    for (const p of (await allProfiles()).profiles) {
      if (p.entorno?.tipo === 'wsl') continue;
      const a = (await agentesVivos([p])).find((x) => x.sessionId === sessionId);
      if (!a) continue;
      const dir = join(p.configDir, 'sessions');
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        const e = JSON.parse(await readFile(join(dir, f), 'utf8').catch(() => '{}'));
        if (e.sessionId === sessionId) return { pid: e.pid, procStart: e.procStart, configDir: p.configDir, cwd: a.cwd };
      }
    }
    return null;
  },
  matar: matarSiEsElMismo,
  lanzar: lanzarClaude,
  alTexto: (sessionId, texto) => {
    const tema = cfg.temas[sessionId];
    if (tg && cfg.chatId) void tg.enviar(cfg.chatId, texto, { tema }).catch(() => {});
  },
  alError: (sessionId, e) => {
    anotar('telegram: toma falló', { sessionId, error: e });
    if (tg && cfg.chatId) void tg.enviar(cfg.chatId, `⚠️ ${e}`, { tema: cfg.temas[sessionId] }).catch(() => {});
  }
});

function estado(): EstadoTelegram {
  const p = presencia.estado();
  return {
    activo: cfg.activo,
    bot,
    vinculado: cfg.chatId !== null,
    codigo: codigo && Date.now() < codigo.vence ? codigo.codigo : '',
    umbralMin: cfg.umbralMin,
    fuera: p.fuera,
    motivo: p.motivo,
    tomadas: tomador.tomadas(),
    error
  };
}

/** `forzar`: escuchar aunque el puente no esté activo, sólo para recibir el `/vincular`. */
async function arrancar(forzar = false): Promise<void> {
  if (señal || (!cfg.activo && !forzar) || !cfg.token) return;
  tg = new Telegram(cfg.token);
  const canal = tg;
  puente = new Puente({
    canal,
    vinculo: () => (cfg.chatId !== null && cfg.userId !== null ? { chatId: cfg.chatId, userId: cfg.userId } : null),
    vincular: async (v) => {
      cfg.chatId = v.chatId;
      cfg.userId = v.userId;
      codigo = null;
      await guardar();
    },
    codigo: () => codigo,
    fuera: () => presencia.estado().fuera,
    setManual: (v) => presencia.setManual(v),
    sesiones: sesionesConNombre,
    ultimoMensaje,
    temas: {
      leer: (s) => cfg.temas[s],
      guardar: async (s, t) => {
        cfg.temas[s] = t;
        await guardar();
      },
      borrar: async (s) => {
        delete cfg.temas[s];
        await guardar();
      },
      sesionDe: (t) => Object.entries(cfg.temas).find(([, v]) => v === t)?.[0]
    },
    carpetaImagenes: IMAGENES(),
    tomar: (s, t) => tomador.enviar(s, t)
  });
  const srv = await iniciarServidor(ARCHIVO_ENDPOINT(), (ev) => puente!.atenderHook(ev));
  cerrarServidor = srv.cerrar;
  cerrarTapa = lanzarAyudanteTapa(recurso('tapa.ps1'), (cerrada) => presencia.setTapa(cerrada));
  presencia.setUmbral(cfg.umbralMin);
  revisarPresencia = setInterval(() => presencia.revisar(), 30_000);
  señal = new AbortController();
  const s = señal;
  void canal
    .escuchar(cfg.offset, (u) => puente!.atenderUpdate(u), (o) => void ((cfg.offset = o), guardar()), s.signal)
    .catch(async (e) => {
      error = e instanceof TelegramError && e.codigo === 401 ? 'Telegram rechazó el token: revisalo.' : String(e);
      anotar('telegram: se apagó', { error });
      cfg.activo = false;
      await guardar();
      await detenerRemoto();
    });
  anotar('telegram: puente arrancado');
}

export async function detenerRemoto(): Promise<void> {
  señal?.abort();
  señal = null;
  await puente?.soltarTodo();
  puente = null;
  await cerrarServidor?.();
  cerrarServidor = null;
  cerrarTapa?.();
  cerrarTapa = null;
  if (revisarPresencia) clearInterval(revisarPresencia);
  revisarPresencia = null;
}

export async function iniciarRemoto(): Promise<void> {
  cfg = await leerConfig(ARCHIVO_CONFIG(), cifrador);
  await borrarViejas(IMAGENES(), 7 * 86_400_000).catch(() => 0);
  if (cfg.token) bot = (await new Telegram(cfg.token).getMe().catch(() => ({ username: '' }))).username;
  await arrancar().catch((e) => anotar('telegram: no arrancó', { error: String(e) }));
}

type Handle = <T>(canal: string, fn: (...args: any[]) => Promise<T>) => void;

export function registrarIpcRemoto(handle: Handle, reanudar: (sessionId: string) => Promise<void>): void {
  handle('telegram:estado', async () => estado());
  handle('telegram:token', async (token: string) => {
    const limpio = String(token ?? '').trim();
    bot = (await new Telegram(limpio).getMe()).username; // lanza si el token no sirve
    cfg = { ...cfg, token: limpio, chatId: null, userId: null, temas: {}, offset: 0 };
    error = '';
    await guardar();
    return estado();
  });
  handle('telegram:vincular', async () => {
    if (!cfg.token) throw new Error('Primero pegá el token del bot.');
    codigo = nuevoCodigo();
    // Para recibir el /vincular hace falta escuchar aunque todavía no esté activo.
    await arrancar(true);
    return estado();
  });
  handle('telegram:activar', async (activo: boolean) => {
    if (activo && (!cfg.token || cfg.chatId === null)) throw new Error('Falta el token o vincular el chat.');
    cfg.activo = Boolean(activo);
    await guardar();
    if (cfg.activo) {
      await instalarHook(recurso(join('hooks', 'remoto-hook.js')), DESTINO_HOOK());
      await arrancar();
    } else {
      await detenerRemoto();
      await sacarHook();
    }
    return estado();
  });
  handle('telegram:umbral', async (minutos: number) => {
    cfg.umbralMin = Math.min(240, Math.max(1, Math.round(Number(minutos) || 10)));
    presencia.setUmbral(cfg.umbralMin);
    await guardar();
    return estado();
  });
  handle('telegram:fuera', async (fuera: boolean | null) => {
    presencia.setManual(fuera === null ? null : Boolean(fuera));
    return estado();
  });
  handle('telegram:reabrir', async (sessionId: string) => {
    tomador.soltar(sessionId);
    await reanudar(sessionId);
    return null;
  });
}
```

- [ ] **Paso 3: conectarlo en `main.ts`**

1. Import: `import { detenerRemoto, iniciarRemoto, registrarIpcRemoto } from './remoto';`
2. Reabrir una sesión continuada desde Telegram es lo mismo que reanudarla desde la lista, así que hay que poder llamar al handler de `sessions:resume` desde afuera. En `main.ts` (línea ~560), `handle('sessions:resume', async (id: string) => { … })` tiene el cuerpo inline:
   - cortar la función flecha completa, desde `async (id: string) => {` hasta su `}` de cierre (el que está antes de `);` y del comentario `// Una cuenta recién creada apunta…`);
   - pegarla antes de `function registerHandlers()` como `const reanudarSesion = async (id: string) => { …el mismo cuerpo… };`;
   - dejar en su lugar `handle('sessions:resume', reanudarSesion);`.

   El cuerpo usa sólo imports del módulo y funciones de nivel superior (`findSession`, `exigirLibre`, `requireLogin`, `openTerminalAs`, `claudeCon`, `profileForWork`, `countCompactions`, `rutaDe`), así que se puede mover tal cual. Si `tsc` marca alguna función como no definida, es porque vive adentro de `registerHandlers`: moverla también arriba.
3. Al final de `registerHandlers()`, agregar:

```ts
  // El puente de Telegram (spec 2026-09-28-telegram-remoto-design.md).
  registrarIpcRemoto(handle, async (sessionId) => void (await reanudarSesion(sessionId)));
```

4. En `app.whenReady().then(...)`, después de `urlOficina().catch(...)`:

```ts
  // El puente de Telegram, si el usuario lo activó.
  iniciarRemoto().catch((e) => anotar('telegram: no arrancó', { error: String(e) }));
```

5. Junto a `app.on('will-quit', detenerOficina);` agregar `app.on('will-quit', () => void detenerRemoto());`.

- [ ] **Paso 4: preload**

En `electron/preload.ts`, agregar al objeto `api`:

```ts
  telegramEstado: () => ipcRenderer.invoke('telegram:estado'),
  telegramToken: (token) => ipcRenderer.invoke('telegram:token', token),
  telegramVincular: () => ipcRenderer.invoke('telegram:vincular'),
  telegramActivar: (activo) => ipcRenderer.invoke('telegram:activar', activo),
  telegramUmbral: (minutos) => ipcRenderer.invoke('telegram:umbral', minutos),
  telegramFuera: (fuera) => ipcRenderer.invoke('telegram:fuera', fuera),
  telegramReabrir: (sessionId) => ipcRenderer.invoke('telegram:reabrir', sessionId)
```

- [ ] **Paso 5: empaquetar el hook y el ayudante**

En `package.json`, dentro de `build.extraResources`, agregar:

```json
      {
        "from": "electron",
        "to": "remoto",
        "filter": ["tapa.ps1", "hooks/remoto-hook.js"]
      }
```

- [ ] **Paso 6: verificar tipos y tests**

Run: `npx tsc --noEmit -p . && npx vitest run`
Esperado: sin errores de tipos; todos los tests pasan (330 anteriores + los nuevos).

- [ ] **Paso 7: commit**

```bash
git add electron/remoto.ts electron/main.ts electron/preload.ts shared/types.ts package.json
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se arma el puente de Telegram con la app: arranca y se detiene con ella y expone la configuración por IPC.
- Se empaquetan el hook y el ayudante de la tapa con la app.
EOF
)"
```

---

### Tarea 11: sección de configuración y "Continuadas desde Telegram"

**Archivos:**
- Crear: `src/TelegramPanel.tsx`
- Modificar: `src/App.tsx` (botón para abrirla, junto a `logs-toggle`, línea ~423; y el panel, junto a `LogsPanel`, línea ~493)
- Modificar: `src/index.css`

**Interfaces:**
- Consume: `window.claudeMonitor.telegram*` y `EstadoTelegram` (Tarea 10).

- [ ] **Paso 1: el panel**

```tsx
// src/TelegramPanel.tsx
import { useEffect, useState } from 'react';
import type { EstadoTelegram, Result } from '../shared/types';

/**
 * La sección de Telegram. La app se reparte al equipo, así que cada uno la arma
 * solo: su bot, su grupo y su chat (spec §9). Viene apagada.
 */
export default function TelegramPanel({ onClose }: { onClose: () => void }) {
  const [e, setE] = useState<EstadoTelegram | null>(null);
  const [token, setToken] = useState('');
  const [aviso, setAviso] = useState('');

  const usar = async (p: Promise<Result<EstadoTelegram>>) => {
    const r = await p;
    if (r.ok) {
      setE(r.data);
      setAviso('');
    } else setAviso(r.error);
  };

  useEffect(() => {
    usar(window.claudeMonitor.telegramEstado());
    const id = setInterval(() => usar(window.claudeMonitor.telegramEstado()), 3000);
    return () => clearInterval(id);
  }, []);

  if (!e) return null;
  const MOTIVO = { manual: 'a mano', tapa: 'tapa cerrada', inactividad: 'sin actividad' } as const;

  return (
    <div className="logs-overlay" onClick={onClose}>
      <div className="logs-panel telegram-panel" onClick={(ev) => ev.stopPropagation()}>
        <div className="logs-header">
          <h2>Telegram</h2>
          <button className="link" onClick={onClose}>Cerrar</button>
        </div>

        <ol className="muted">
          <li>Creá un bot con @BotFather y copiá el token.</li>
          <li>Creá un grupo, activá <b>Temas</b> y agregá el bot como administrador con "Gestionar temas".</li>
          <li>Pegá el token acá, tocá Vincular y mandale el código al bot en el grupo.</li>
        </ol>
        <p className="muted">
          Lo que pide permiso y el último mensaje de cada turno pasan por los servidores de Telegram.
        </p>

        <label>
          Token del bot {e.bot && <span className="muted">(@{e.bot})</span>}
          <input type="password" value={token} onChange={(ev) => setToken(ev.target.value)} placeholder="123456:ABC…" />
        </label>
        <button onClick={() => usar(window.claudeMonitor.telegramToken(token)).then(() => setToken(''))} disabled={!token.trim()}>
          Probar y guardar
        </button>

        <div>
          <button onClick={() => usar(window.claudeMonitor.telegramVincular())} disabled={!e.bot}>
            {e.vinculado ? 'Vincular otro chat' : 'Vincular'}
          </button>
          {e.codigo && (
            <span>
              {' '}Mandá <code>/vincular {e.codigo}</code> en el grupo (vence en 10 min).
            </span>
          )}
          {e.vinculado && !e.codigo && <span className="muted"> Chat vinculado.</span>}
        </div>

        <label>
          Modo fuera tras
          <input
            type="number"
            min={1}
            max={240}
            value={e.umbralMin}
            onChange={(ev) => usar(window.claudeMonitor.telegramUmbral(Number(ev.target.value)))}
          />
          minutos sin tocar teclado ni mouse
        </label>

        <label className="telegram-switch">
          <input
            type="checkbox"
            checked={e.activo}
            disabled={!e.vinculado && !e.activo}
            onChange={(ev) => usar(window.claudeMonitor.telegramActivar(ev.target.checked))}
          />
          Activo
        </label>

        <div>
          Estado: <b>{e.fuera ? `fuera (${e.motivo ? MOTIVO[e.motivo] : ''})` : 'en la PC'}</b>{' '}
          <button className="link" onClick={() => usar(window.claudeMonitor.telegramFuera(!e.fuera))}>
            {e.fuera ? 'Volví' : 'Me voy'}
          </button>
          {e.motivo === 'manual' && (
            <button className="link" onClick={() => usar(window.claudeMonitor.telegramFuera(null))}>Automático</button>
          )}
        </div>

        {e.tomadas.length > 0 && (
          <div>
            <h3>Continuadas desde Telegram</h3>
            <ul>
              {e.tomadas.map((id) => (
                <li key={id}>
                  <code>{id.slice(0, 8)}</code>{' '}
                  <button className="link" onClick={() => window.claudeMonitor.telegramReabrir(id)}>Reabrir en terminal</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(aviso || e.error) && <p className="error">{aviso || e.error}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Paso 2: conectarlo en `App.tsx`**

1. `import TelegramPanel from './TelegramPanel';`
2. `const [showTelegram, setShowTelegram] = useState(false);` junto a `showLogs`.
3. Al lado del botón `logs-toggle` (línea ~423):

```tsx
        <button className="link logs-toggle" onClick={() => setShowTelegram(true)}>
          Telegram
        </button>
```

4. Al lado de `{showLogs && (…)}` (línea ~493):

```tsx
      {showTelegram && <TelegramPanel onClose={() => setShowTelegram(false)} />}
```

- [ ] **Paso 3: estilos mínimos**

Agregar al final de `src/index.css`:

```css
.telegram-panel { display: flex; flex-direction: column; gap: 10px; max-width: 560px; }
.telegram-panel label { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.telegram-panel input[type='password'] { flex: 1; min-width: 220px; }
.telegram-panel input[type='number'] { width: 64px; }
.telegram-panel ol { margin: 0; padding-left: 18px; }
```

- [ ] **Paso 4: verificar**

Run: `npx tsc --noEmit -p . && npx vitest run && npm run build`
Esperado: sin errores; el build de electron-vite termina bien.

Después abrir la app en desarrollo (`npm run dev`), tocar **Telegram** y confirmar que el panel abre, muestra la guía, y que **Activo** está deshabilitado sin vincular.

- [ ] **Paso 5: commit**

```bash
git add src/TelegramPanel.tsx src/App.tsx src/index.css
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega la sección de Telegram en la app, con la guía, el token, la vinculación, el modo fuera y las sesiones continuadas desde Telegram.
EOF
)"
```

---

### Tarea 12: guía, versión y prueba de punta a punta

**Archivos:**
- Modificar: `README.md` (sección nueva "Telegram")
- Modificar: `package.json` (versión 0.23.0)

- [ ] **Paso 1: README**

Agregar al `README.md`:

```markdown
## Telegram (seguir a los agentes desde el celular)

Cuando no estás en la PC, la app te manda a Telegram lo que tus agentes necesitan y te deja contestar desde ahí.

1. En Telegram, hablale a **@BotFather**, mandá `/newbot` y copiá el token.
2. Creá un grupo, activá **Temas** (Ajustes del grupo → Temas) y agregá tu bot como **administrador** con permiso **Gestionar temas**.
3. En la app: **Telegram** → pegá el token → **Probar y guardar** → **Vincular** → mandá en el grupo el `/vincular 123456` que te muestra.
4. Prendé **Activo**. Las sesiones que abras desde ese momento usan el puente; las que ya estaban abiertas, al reabrirlas.

Cada sesión tiene su tema. Te llegan los pedidos de permiso (✅/❌), las preguntas (con botones) y el fin de cada turno: lo que escribas en el tema es la siguiente instrucción. También podés mandar fotos.

`/estado` muestra cómo va cada sesión; `/fuera` y `/vuelvo` fuerzan el modo. El modo fuera se activa solo al cerrar la tapa o tras los minutos sin actividad que elijas, y se apaga al volver a usar la PC.

Lo que pide permiso y el último mensaje de cada turno pasan por los servidores de Telegram.
```

- [ ] **Paso 2: versión**

Run: `npm version 0.23.0 --no-git-tag-version`

- [ ] **Paso 3: prueba de punta a punta (manual, con un bot real, en la PC del usuario)**

Con la app en desarrollo (`npm run dev`) y el puente activo:

1. Abrir una sesión nueva desde la app. Mandar `/fuera` en el grupo.
2. Pedirle "corré `echo hola > x.txt`". Esperado: llega 🔐 al tema de esa sesión; ✅ lo deja correr.
3. Pedirle "preguntame con AskUserQuestion mi color favorito". Esperado: llegan botones; tocar uno y confirmar que el agente lo usa.
4. Al terminar el turno, esperado: llega ✅ con su último mensaje. Contestar "ahora decime la hora". Esperado: el agente sigue.
5. Mandar una foto con el texto "¿qué ves?". Esperado: el agente la describe.
6. `/vuelvo`, dejar la sesión quieta, `/fuera` y escribirle en su tema. Esperado: la terminal muestra que el `claude` terminó; la respuesta llega al tema; en la app aparece en "Continuadas desde Telegram" y **Reabrir en terminal** la abre.
7. Con un permiso esperando en Telegram, tocar el teclado de la PC (o `/vuelvo`). Esperado: el permiso aparece en la terminal y el mensaje de Telegram cambia a "✋ Retomado en la PC"; tocar su botón viejo contesta "Ya no está vigente".
8. `/estado` en General: lista las sesiones con su estado.

Anotar en el commit qué pasos se probaron. Si algo falla, abrir un issue con el paso y la salida del panel **Registro**.

- [ ] **Paso 4: build final**

Run: `npx vitest run && npm run dist`
Esperado: tests en verde y `release/Claude Monitor 0.23.0/` con el portable y el instalador.

- [ ] **Paso 5: commit**

```bash
git add README.md package.json package-lock.json
git commit -m "$(cat <<'EOF'
telegram-remoto

- Se agrega la guía del puente de Telegram al README.
- Se sube la versión a 0.23.0.
EOF
)"
```
