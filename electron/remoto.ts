/**
 * Arma el puente de Telegram con las piezas de `telegram.ts`, `puente.ts`,
 * `presencia.ts`, `tomar.ts` y `remoto-servidor.ts`, y lo conecta con la app:
 * arranca y se detiene con ella, y responde el IPC de la sección de
 * configuración (`src/TelegramPanel.tsx`). Spec:
 * `docs/superpowers/specs/2026-09-28-telegram-remoto-design.md`.
 *
 * Las APIs de Electron (`app`, `safeStorage`, `powerMonitor`) se tocan sólo
 * adentro de funciones, nunca al importar: así los tests importan los
 * ayudantes puros de acá abajo sin levantar Electron.
 */

import { app, powerMonitor, safeStorage } from 'electron';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgenteOficina, EstadoAgente, EstadoTelegram } from '../shared/types';
import { agentesVivos, conversacionDe, rutaViva } from './oficina';
import { leerNombres } from './nombres';
import { Presencia, lanzarAyudanteTapa } from './presencia';
import { allProfiles } from './profiles';
import { Puente } from './puente';
import { anotar } from './registro';
import { borrarViejas, CONFIG_INICIAL, guardarConfig, leerConfig, nuevoCodigo, type ConfigRemoto } from './remoto-config';
import { hayNode, instalarHook, sacarHook } from './remoto-instalar';
import { iniciarServidor } from './remoto-servidor';
import { Telegram, TelegramError } from './telegram';
import { progresoDe } from './telegram-progreso';
import { lanzarClaude, matarSiEsElMismo, Tomador, type Registro } from './tomar';

/** El umbral de inactividad, siempre entre 1 y 240 minutos (10 si no es un número). */
export const acotarUmbral = (minutos: unknown): number => Math.min(240, Math.max(1, Math.round(Number(minutos) || 10)));

/**
 * Los ids de tema son propios de cada chat: si se vincula otro chat, los del
 * anterior podrían mandar el tema de la sesión B a la sesión A. Cambia el chat,
 * se borran.
 */
export const temasTrasVincular = (temas: Record<string, number>, chatActual: number | null, chatNuevo: number) =>
  chatActual === chatNuevo ? temas : {};

/** Arma el `Registro` que necesita el Tomador con una entrada de `sessions/<pid>.json`. */
export function registroDe(entrada: { pid: number; procStart?: unknown }, configDir: string, cwd: string, quieta: boolean): Registro {
  return {
    pid: entrada.pid,
    procStart: entrada.procStart == null ? undefined : String(entrada.procStart),
    configDir,
    cwd,
    quieta
  };
}

/** Entre las entradas de `sessions/` de una misma sesión (quedan restos de arranques viejos) gana la del proceso más nuevo. */
export function elegirEntrada<T extends { sessionId?: unknown; procStart?: unknown }>(entradas: T[], sessionId: string): T | undefined {
  const inicio = (e: T) => {
    try {
      return BigInt(String(e.procStart));
    } catch {
      return -1n;
    }
  };
  return entradas.filter((e) => e.sessionId === sessionId).sort((a, b) => (inicio(b) > inicio(a) ? 1 : inicio(b) < inicio(a) ? -1 : 0))[0];
}

/** Cuánto se sigue mostrando "escribiendo…" aunque el registro todavía diga "te espera": tarda en enterarse de que arrancó. */
export const GRACIA_TIPEO_MS = 15_000;
/** Tope por si una sesión nunca vuelve a quedar quieta (se cerró la terminal a mitad de turno). */
export const MAX_TIPEO_MS = 2 * 3600_000;

/**
 * Las sesiones a las que el usuario les escribió desde Telegram y que siguen
 * trabajando: a esas se les muestra "escribiendo…" en su tema. Saca del mapa a
 * las que ya terminaron (te esperan o piden permiso: eso ya llega como mensaje),
 * a las que desaparecieron y a las que pasaron el tope.
 */
export function aTipear(
  trabajando: Map<string, number>,
  estados: Map<string, EstadoAgente>,
  ocupada: (sessionId: string) => boolean,
  ahora: number
): string[] {
  const salida: string[] = [];
  for (const [id, desde] of trabajando) {
    const recien = ahora - desde < GRACIA_TIPEO_MS;
    const estado = estados.get(id);
    const quieta = estado === undefined || estado === 'esperando' || estado === 'permiso';
    if (ahora - desde > MAX_TIPEO_MS || (!ocupada(id) && quieta && !recien)) {
      trabajando.delete(id);
      continue;
    }
    salida.push(id);
  }
  return salida;
}

/**
 * Una sesión tomada no tiene terminal, así que `agentesVivos` ya no la ve: sin
 * esto el puente diría "Esa sesión terminó" a la segunda respuesta. Se la
 * agrega como quieta (`esperando`), que es como queda entre turno y turno.
 */
export function conTomadas(
  agentes: AgenteOficina[],
  tomadas: Array<{ sessionId: string; cwd: string; profileId: string; profileName: string }>,
  nombres: Record<string, { nombre?: string } | undefined>
): AgenteOficina[] {
  const vistas = new Set(agentes.map((a) => a.sessionId));
  const propias = new Set(tomadas.map((t) => t.sessionId));
  // El Stop de un turno tomado lo saltea el hook: si la vieran trabajando, lo que se le escriba
  // quedaría guardado para un Stop que nunca llega.
  const vivas = agentes.map((a) => (propias.has(a.sessionId) ? { ...a, estado: 'esperando' as const } : a));
  const extra = tomadas
    .filter((t) => !vistas.has(t.sessionId))
    .map<AgenteOficina>((t) => ({
      sessionId: t.sessionId,
      profileId: t.profileId,
      profileName: t.profileName,
      nombre: nombres[t.sessionId]?.nombre || t.cwd.split(/[\\/]/).filter(Boolean).pop() || t.cwd,
      cwd: t.cwd,
      origen: 'terminal',
      transcript: '',
      estado: 'esperando',
      herramienta: '',
      detalle: '',
      subagentes: [],
      nombrePropio: '',
      nota: '',
      mensajes: []
    }));
  return [...vivas, ...extra];
}

/** Mientras el puente está apagado sólo se procesa el emparejado (`/vincular`): nada de tomar sesiones ni contestar. */
export const atiendeUpdates = (activo: boolean, chatId: number | null) => activo || chatId === null;

const appdata = () => process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const ARCHIVO_CONFIG = () => join(appdata(), 'claude-monitor', 'telegram.json');
const ARCHIVO_ENDPOINT = () => join(appdata(), 'claude-monitor', 'remoto.json');
const CARPETA_HOOKS = () => join(appdata(), 'claude-monitor', 'hooks');
const DESTINO_HOOK = () => join(CARPETA_HOOKS(), 'remoto-hook.js');
const DESTINO_TAPA = () => join(CARPETA_HOOKS(), 'tapa.ps1');
const IMAGENES = () => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'claude-monitor', 'telegram');
const recurso = (nombre: string) =>
  app.isPackaged ? join(process.resourcesPath, 'remoto', nombre) : join(app.getAppPath(), 'electron', nombre);

/**
 * En la versión portable `process.resourcesPath` cuelga de un Temp que se
 * borra al cerrar: ni el hook ni la tapa pueden correr desde ahí. Se copian a
 * una carpeta estable y se usan siempre desde ella.
 */
async function desplegarRecursos(): Promise<void> {
  await mkdir(CARPETA_HOOKS(), { recursive: true });
  await copyFile(recurso('tapa.ps1'), DESTINO_TAPA());
  await copyFile(recurso(join('hooks', 'remoto-hook.js')), DESTINO_HOOK());
}

const cifrador = {
  cifrar: (t: string) => safeStorage.encryptString(t),
  descifrar: (b: Buffer) => safeStorage.decryptString(b)
};

let cfg: ConfigRemoto = { ...CONFIG_INICIAL, temas: {} };
let bot = '';
let error = '';
let codigo: { codigo: string; vence: number } | null = null;
let señal: AbortController | null = null;
let cerrarServidor: (() => Promise<void>) | null = null;
let cerrarTapa: (() => void) | null = null;
let revisarPresencia: ReturnType<typeof setInterval> | null = null;
let pulsoTipeo: ReturnType<typeof setInterval> | null = null;
/** sessionId → cuándo se le entregó el último mensaje desde Telegram. */
const trabajando = new Map<string, number>();
/** El mensaje "⏳ Trabajando…" de cada sesión: se edita mientras avanza y se borra al terminar. */
const progreso = new Map<string, { mensajeId: number; texto: string }>();
let tipeando = false;
let puente: Puente | null = null;
let arrancando: Promise<void> | null = null;
/** La config se lee al arrancar la app: el IPC espera a que esté, o pisaría el token con los valores iniciales. */
let cargado: Promise<void> = Promise.resolve();
let tg: Telegram | null = null;
const guardar = () => guardarConfig(ARCHIVO_CONFIG(), cfg, cifrador);

const presencia = new Presencia(
  () => powerMonitor.getSystemIdleTime(),
  CONFIG_INICIAL.umbralMin,
  (e) => {
    anotar('telegram: modo fuera', { fuera: e.fuera, motivo: e.motivo });
    if (!e.fuera) puente?.soltarTodo(true);
  }
);

async function sesionesConNombre() {
  const { profiles } = await allProfiles();
  const [agentes, nombres] = await Promise.all([agentesVivos(profiles), leerNombres()]);
  const tomadas = tomador.tomadas().flatMap((sessionId) => {
    const r = tomador.registroDe(sessionId);
    const p = r && profiles.find((x) => x.configDir === r.configDir);
    return r ? [{ sessionId, cwd: r.cwd, profileId: p?.id ?? '', profileName: p?.name ?? '' }] : [];
  });
  return conTomadas(
    agentes.map((a) => ({ ...a, nombre: nombres[a.sessionId]?.nombre || a.nombre })),
    tomadas,
    nombres
  );
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
      const entradas: Array<{ sessionId?: string; pid: number; procStart?: unknown }> = [];
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        try {
          entradas.push(JSON.parse(await readFile(join(dir, f), 'utf8')));
        } catch {
          // un archivo a medio escribir o ajeno no debe voltear la búsqueda
        }
      }
      const e = elegirEntrada(entradas, sessionId);
      if (e) return registroDe(e, p.configDir, a.cwd, a.estado === 'esperando');
    }
    return null;
  },
  matar: matarSiEsElMismo,
  lanzar: lanzarClaude,
  alTexto: (sessionId, texto) => {
    const tema = cfg.temas[sessionId];
    if (tg && cfg.chatId) void tg.enviar(cfg.chatId, texto, { tema, md: true }).catch(() => {});
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

async function tipear(canal: Telegram): Promise<void> {
  // Una vuelta lenta (red) no se superpone con la siguiente: mandaría dos mensajes de progreso.
  if (tipeando || (!trabajando.size && !progreso.size) || cfg.chatId === null) return;
  tipeando = true;
  try {
    const chat = cfg.chatId;
    const vivos = await agentesVivos((await allProfiles()).profiles);
    const estados = new Map(vivos.map((a) => [a.sessionId, a.estado] as const));
    const activas = aTipear(trabajando, estados, (s) => tomador.ocupada(s), Date.now());
    for (const id of activas) {
      const tema = cfg.temas[id];
      void canal.escribiendo(chat, tema).catch(() => {});
      const ruta = vivos.find((a) => a.sessionId === id)?.transcript || (await rutaDeTomada(id));
      if (!ruta) continue;
      const texto = progresoDe((await conversacionDe(ruta).catch(() => ({ items: [] }))).items);
      const previo = progreso.get(id);
      if (previo?.texto === texto) continue;
      if (previo) await canal.editar(chat, previo.mensajeId, texto).catch(() => {});
      else {
        const mensajeId = await canal.enviar(chat, texto, { tema });
        if (trabajando.has(id)) progreso.set(id, { mensajeId, texto });
        else void canal.borrar(chat, mensajeId).catch(() => {});
      }
      if (previo) previo.texto = texto;
    }
    // Terminó (o pide algo): su respuesta llega aparte, así que el progreso se va.
    for (const [id, p] of progreso) {
      if (activas.includes(id)) continue;
      progreso.delete(id);
      void canal.borrar(chat, p.mensajeId).catch(() => {});
    }
  } finally {
    tipeando = false;
  }
}

async function cerrarProgreso(canal: Telegram, sessionId: string): Promise<void> {
  trabajando.delete(sessionId);
  const p = progreso.get(sessionId);
  progreso.delete(sessionId);
  if (p && cfg.chatId !== null) await canal.borrar(cfg.chatId, p.mensajeId).catch(() => {});
}

/** El transcript de una sesión tomada: sin terminal, `agentesVivos` no la ve. */
async function rutaDeTomada(id: string): Promise<string | null> {
  const r = tomador.registroDe(id);
  return r ? rutaViva(r.configDir, r.cwd, id) : null;
}

/** Deja todo lo que arrancó `iniciar` sin esperar a un arranque en curso (lo usan `detenerRemoto` y el propio arranque si falla). */
async function derribar(): Promise<void> {
  // Todo se saca de los campos antes del primer await: si mientras se espera arranca otro
  // puente, sus piezas nuevas no se tocan y las viejas no quedan colgadas.
  const ctl = señal;
  const p = puente;
  const srv = cerrarServidor;
  const tapa = cerrarTapa;
  const reloj = revisarPresencia;
  const pulso = pulsoTipeo;
  señal = null;
  puente = null;
  cerrarServidor = null;
  cerrarTapa = null;
  revisarPresencia = null;
  pulsoTipeo = null;
  trabajando.clear();
  progreso.clear();
  ctl?.abort();
  tapa?.();
  if (reloj) clearInterval(reloj);
  if (pulso) clearInterval(pulso);
  p?.soltarTodo();
  await srv?.();
}

/** Sacar el hook puede fallar (settings.json ilegible): se ve en pantalla en vez de perderse. */
async function quitarHook(): Promise<void> {
  try {
    await sacarHook();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

/**
 * `forzar`: escuchar aunque el puente no esté activo, sólo para recibir el `/vincular`.
 * Idempotente: si ya hay un arranque en curso se devuelve el mismo.
 */
function arrancar(forzar = false): Promise<void> {
  if (señal || (!cfg.activo && !forzar) || !cfg.token) return Promise.resolve();
  arrancando ??= iniciar().finally(() => (arrancando = null));
  return arrancando;
}

async function iniciar(): Promise<void> {
  try {
    await desplegarRecursos();
    // Una versión nueva puede sumar eventos al hook: reinstalarlo (es idempotente) los lleva a las cuentas sin reactivar.
    if (cfg.activo) await instalarHook(recurso(join('hooks', 'remoto-hook.js')), DESTINO_HOOK()).catch((e) => anotar('telegram: no pude actualizar el hook', { error: String(e) }));
    const canal = new Telegram(cfg.token);
    tg = canal;
    const p = new Puente({
      canal,
      vinculo: () => (cfg.chatId !== null && cfg.userId !== null ? { chatId: cfg.chatId, userId: cfg.userId } : null),
      vincular: async (v) => {
        cfg.temas = temasTrasVincular(cfg.temas, cfg.chatId, v.chatId);
        cfg.chatId = v.chatId;
        cfg.userId = v.userId;
        codigo = null;
        await guardar();
        // Se escuchaba sólo para emparejar: ya está, se apaga hasta que lo activen.
        if (!cfg.activo) void detenerRemoto();
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
      tomar: (s, t) => tomador.enviar(s, t),
      alError: (e) => anotar('telegram: error', { error: String(e) }),
      // 👀 en su mensaje apenas le llega a la sesión, y desde ahí "escribiendo…" mientras trabaja.
      // Al terminar el turno se va el "⏳ Trabajando…": en el tema queda sólo la respuesta final.
      alTerminarTurno: (s) => cerrarProgreso(canal, s),
      alEntregar: (s, mensajeId, activa) => {
        if (activa) trabajando.set(s, Date.now());
        if (cfg.chatId !== null) void canal.reaccionar(cfg.chatId, mensajeId).catch(() => {});
      }
    });
    puente = p;
    const srv = await iniciarServidor(ARCHIVO_ENDPOINT(), async (ev, s) => (cfg.activo ? p.atenderHook(ev, s) : {}));
    cerrarServidor = srv.cerrar;
    cerrarTapa = lanzarAyudanteTapa(DESTINO_TAPA(), (cerrada) => presencia.setTapa(cerrada));
    presencia.setUmbral(cfg.umbralMin);
    revisarPresencia = setInterval(() => presencia.revisar(), 30_000);
    // Telegram muestra "escribiendo…" unos 5 s: se renueva cada 4.
    pulsoTipeo = setInterval(() => void tipear(canal).catch((e) => anotar('telegram: error', { error: String(e) })), 4_000);
    const ctl = new AbortController();
    señal = ctl;
    void canal
      .escuchar(
        cfg.offset,
        async (u) => {
          if (atiendeUpdates(cfg.activo, cfg.chatId)) await p.atenderUpdate(u);
        },
        (o) => {
          cfg.offset = o;
          guardar().catch((e) => anotar('telegram: no guardó el offset', { error: String(e) }));
        },
        ctl.signal,
        (e, u) => anotar('telegram: error', { update: u.update_id, error: String(e) })
      )
      .catch(async (e) => {
        const revocado = e instanceof TelegramError && e.codigo === 401;
        error = revocado ? 'Telegram rechazó el token: revisalo.' : String(e);
        if (revocado) bot = '';
        anotar('telegram: se apagó', { error });
        cfg.activo = false;
        await guardar().catch((g) => anotar('telegram: no guardó', { error: String(g) }));
        await detenerRemoto();
        await sacarHook().catch((h) => {
          error = `${error} ${h instanceof Error ? h.message : String(h)}`;
        });
      });
    anotar('telegram: puente arrancado');
  } catch (e) {
    await derribar().catch(() => {});
    throw e;
  }
}

export async function detenerRemoto(): Promise<void> {
  // Si justo se está arrancando, se espera a que termine: derribar a medias dejaría el servidor abierto.
  await arrancando?.catch(() => {});
  await derribar();
}

export async function iniciarRemoto(): Promise<void> {
  cargado = leerConfig(ARCHIVO_CONFIG(), cifrador).then((c) => {
    cfg = c;
  });
  await cargado;
  await borrarViejas(IMAGENES(), 7 * 86_400_000).catch(() => 0);
  if (cfg.token) bot = (await new Telegram(cfg.token).getMe().catch(() => ({ username: '' }))).username;
  await arrancar().catch((e) => anotar('telegram: no arrancó', { error: String(e) }));
}

/** La sesión volvió a una terminal o a Desktop (se reanudó desde la lista): deja de estar tomada por el puente. */
export const soltarTomada = (sessionId: string): void => tomador.soltar(sessionId);

/** Abrirla en una terminal (o en Desktop) con un turno de Telegram corriendo pondría dos procesos en el mismo transcript. */
export function exigirSinTurno(sessionId: string): void {
  if (tomador.ocupada(sessionId)) throw new Error('Esa sesión está haciendo un turno desde Telegram: esperá a que termine.');
}

type Handle = <T>(canal: string, fn: (...args: any[]) => Promise<T>) => void;

export function registrarIpcRemoto(handle: Handle, reanudar: (sessionId: string) => Promise<void>): void {
  handle('telegram:estado', async () => {
    await cargado;
    return estado();
  });
  handle('telegram:token', async (token: string) => {
    await cargado;
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows no deja cifrar el token en este usuario.');
    const limpio = String(token ?? '').trim();
    bot = (await new Telegram(limpio).getMe()).username; // lanza si el token no sirve
    if (cfg.token !== '' && limpio !== cfg.token) {
      // Otro bot: el puente y el chat vinculado del anterior ya no valen.
      await detenerRemoto();
      cfg = { ...cfg, token: limpio, activo: false, chatId: null, userId: null, temas: {}, offset: 0 };
      error = '';
      await quitarHook().catch(() => {});
      await guardar();
      return estado();
    }
    // Token vacío (perfil movido) o el mismo: se recupera sin perder chat ni temas.
    cfg = { ...cfg, token: limpio };
    error = '';
    await guardar();
    return estado();
  });
  handle('telegram:vincular', async () => {
    await cargado;
    if (!cfg.token) throw new Error('Primero pegá el token del bot.');
    // Ya vinculado, pedir el código es "Vincular otro chat": se desvincula el actual.
    if (cfg.chatId !== null) {
      // Las esperas son del chat viejo: nadie las va a contestar desde el nuevo.
      puente?.soltarTodo();
      cfg.chatId = null;
      cfg.userId = null;
      cfg.temas = {};
      await guardar();
    }
    codigo = nuevoCodigo();
    // Para recibir el /vincular hace falta escuchar aunque todavía no esté activo.
    await arrancar(true);
    return estado();
  });
  handle('telegram:activar', async (activo: boolean) => {
    await cargado;
    if (activo && (!cfg.token || cfg.chatId === null)) throw new Error('Falta el token o vincular el chat.');
    if (activo) {
      try {
        if (!(await hayNode())) throw new Error('Falta Node.js en esta PC: el hook lo necesita.');
        await desplegarRecursos();
        await instalarHook(recurso(join('hooks', 'remoto-hook.js')), DESTINO_HOOK());
      } catch (e) {
        // Sin hook no hay puente: queda apagado y el motivo se ve en la pantalla.
        error = e instanceof Error ? e.message : String(e);
        cfg.activo = false;
        await guardar();
        throw e;
      }
      error = '';
      cfg.activo = true;
      await guardar();
      await arrancar();
    } else {
      cfg.activo = false;
      await guardar();
      await detenerRemoto();
      await quitarHook();
    }
    return estado();
  });
  handle('telegram:umbral', async (minutos: number) => {
    await cargado;
    cfg.umbralMin = acotarUmbral(minutos);
    presencia.setUmbral(cfg.umbralMin);
    await guardar();
    return estado();
  });
  handle('telegram:fuera', async (fuera: boolean | null) => {
    presencia.setManual(fuera === null ? null : Boolean(fuera));
    return estado();
  });
  handle('telegram:reabrir', async (sessionId: string) => {
    exigirSinTurno(sessionId);
    await reanudar(sessionId);
    tomador.soltar(sessionId);
    return null;
  });
}
