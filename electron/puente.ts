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
  describirCambio,
  leerCambioModelo,
  textoCompactado,
  textoCompactando,
  type CambioModelo,
  respuestaPaso,
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
import type { Compactacion } from './sessions';
import { TelegramError, type Mensaje, type Telegram, type Update } from './telegram';

export type Canal = Pick<Telegram, 'enviar' | 'editar' | 'contestarBoton' | 'crearTema' | 'descargar'> &
  Partial<Pick<Telegram, 'borrar'>>;
export type Vinculo = { chatId: number; userId: number };
export type DepsPuente = {
  canal: Canal;
  vinculo: () => Vinculo | null;
  vincular: (v: Vinculo) => Promise<void>;
  codigo: () => { codigo: string; vence: number } | null;
  /** Demasiados códigos equivocados: invalidar el vigente (y anotar quién los mandó). */
  quemarCodigo?: (de: { userId: number; chatId: number }) => void;
  fuera: () => boolean;
  setManual: (v: boolean | null) => void;
  sesiones: () => Promise<AgenteOficina[]>;
  ultimoMensaje: (transcript: string) => Promise<string>;
  temas: {
    leer: (sessionId: string) => number | undefined;
    guardar: (sessionId: string, tema: number) => Promise<void>;
    borrar: (sessionId: string) => Promise<void>;
    sesionDe: (tema: number) => string | undefined;
  };
  carpetaImagenes: string;
  tomar: (sessionId: string, texto: string) => Promise<void>;
  esperaAlbumMs?: number;
  esperaReintentoMs?: number;
  /** Errores de tareas sin quien las espere (el álbum que se arma con un temporizador): que los loguee quien construye el puente. */
  alError?: (e: unknown) => void;
  /** Un mensaje del usuario le llegó a su sesión (o quedó guardado para su próximo Stop): para confirmárselo en el chat. */
  alEntregar?: (sessionId: string, mensajeId: number, trabajando: boolean) => void;
  /** Terminó el turno (su Stop): lo que mostraba el avance sobra antes de que llegue la respuesta final. */
  alTerminarTurno?: (sessionId: string) => Promise<void> | void;
  /** Cierra la sesión (quieta) y la reabre en una terminal con otro modelo o esfuerzo. */
  cambiarModelo: (sessionId: string, cambio: CambioModelo) => Promise<void>;
  /** Lo que se deja pasar entre soltar el Stop y cerrar el proceso, para que el hook alcance a contestar. */
  esperaCambioMs?: number;
  /** Los números de la última compactación del transcript (tokens antes y después, duración). */
  compactacion?: (transcript: string) => Promise<Compactacion | null>;
  /** Cada cuánto se actualiza el reloj de "Compactando…". */
  relojCompactarMs?: number;
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
  /** Pregunta en curso (de `preguntas`) y lo respondido hasta ahora, por texto de pregunta. */
  indice?: number;
  respuestas?: Record<string, string>;
  /** Pasando a la pregunta siguiente: un toque en los botones viejos no cuenta. */
  avanzando?: boolean;
  /** Un Stop que escucha Telegram estando el usuario en la PC: no se suelta al volver de "fuera". */
  enPC?: boolean;
};

/** Tope del reloj de "Compactando…": si el PostCompact nunca llega (se cerró la consola), deja de editar. */
const MAX_RELOJ_MS = 15 * 60_000;

const AYUDA =
  'Cada sesión tiene su tema: escribí ahí para contestarle.\n/estado — cómo va cada sesión\n/fuera · /vuelvo — forzar el modo fuera\n' +
  '/model · /effort · /compact — en el tema de una sesión, la reabre con otro modelo, esfuerzo o compactada';

export class Puente {
  private esperas = new Map<string, Espera>();
  /** Lo que se le escribió a una sesión que estaba trabajando: va en su próximo Stop. */
  private guardado = new Map<string, string>();
  /** Un /model o /effort pedido mientras la sesión trabajaba: se aplica en el Stop que cierra ese turno. */
  private cambios = new Map<string, CambioModelo>();
  /** Códigos de /vincular equivocados contra el vigente (ver `intentarVincular`). */
  private fallosCodigo = { codigo: '', n: 0 };
  /** Avisos del bot que sobran cuando llega la respuesta ("Recibido: …"): se borran para que quede sólo la respuesta. */
  private transitorios = new Map<string, number[]>();
  private creandoTema = new Map<string, Promise<number>>();
  /** El mensaje "Compactando… ⏱" de cada sesión, que se edita con el reloj hasta el PostCompact. */
  private compactando = new Map<
    string,
    { mensajeId: Promise<number>; desde: number; timer: ReturnType<typeof setInterval>; cola: Promise<void> }
  >();
  private albumes = new Map<string, { sessionId: string; texto: string; fotos: string[]; mensajeId: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private d: DepsPuente) {}

  /**
   * `señal` la aborta el endpoint cuando Claude Code mató el hook (el usuario apretó
   * Esc o contestó en la terminal): esa espera ya no tiene a quién responderle.
   */
  async atenderHook(ev: EventoHook, señal?: AbortSignal): Promise<object> {
    if (ev.hook_event_name === 'SessionStart') return contextoInicio();
    if (ev.hook_event_name === 'PreCompact') return this.empezarCompactar(ev.session_id);
    if (ev.hook_event_name === 'PostCompact') return this.avisarCompactado(ev.session_id, ev.transcript_path);
    const v = this.d.vinculo();
    if (!v) return {};

    // Lo que se escribió mientras trabajaba entra en el turno en curso, después de su próxima herramienta.
    if (ev.hook_event_name === 'PostToolUse') {
      const g = this.guardado.get(ev.session_id);
      if (g === undefined || señal?.aborted) return {};
      this.guardado.delete(ev.session_id);
      this.limpiarTransitorios(ev.session_id);
      return respuestaPaso(g);
    }

    if (ev.hook_event_name === 'Stop') {
      this.limpiarTransitorios(ev.session_id);
      await Promise.resolve(this.d.alTerminarTurno?.(ev.session_id)).catch(() => {});
      const guardado = this.guardado.get(ev.session_id);
      // Lo que se escribió mientras la sesión trabajaba se consume una sola vez, en el Stop que cierra ese turno:
      // guardado para después aparecería horas más tarde, en un Stop que ya no tiene que ver. Afuera se entrega;
      // en la PC un Stop nunca recibe instrucción (spec §4.2 y §5.4), así que se descarta y se avisa.
      // Con el hook ya muerto nadie recibe la respuesta: el texto se queda para el próximo Stop.
      // Lo escribió desde Telegram a propósito: le llega aunque esté en la PC (el turno terminó sin otra herramienta).
      if (guardado !== undefined && !señal?.aborted) {
        this.guardado.delete(ev.session_id);
        return respuestaStop(guardado, []);
      }
      const cambio = this.cambios.get(ev.session_id);
      if (cambio && !señal?.aborted) {
        this.cambios.delete(ev.session_id);
        this.aplicarCambio(ev.session_id, cambio);
        return {};
      }
      // En la PC, una sesión que ya se usa desde Telegram (tiene tema) igual queda escuchando: si le
      // escribís desde el celular sigue en su misma consola, a la vista. Esc en la consola corta la espera.
      const enPC = !this.d.fuera();
      if (enPC && this.d.temas.leer(ev.session_id) === undefined) return {};
      const ultimo = ev.transcript_path ? await this.d.ultimoMensaje(ev.transcript_path).catch(() => '') : '';
      return this.esperar(ev.session_id, 'stop', textoFin(ultimo), undefined, enPC ? { enPC } : {}, señal);
    }
    if (!this.d.fuera()) return {};
    if (ev.hook_event_name === 'PermissionRequest') {
      return this.esperar(ev.session_id, 'permiso', textoPermiso(ev), (id) => botonesPermiso(id), {}, señal);
    }
    if (ev.hook_event_name === 'PreToolUse' && ev.tool_name === 'AskUserQuestion') {
      const preguntas = (ev.tool_input?.questions as Pregunta[] | undefined) ?? [];
      if (!preguntas.length) return {};
      // AskUserQuestion puede traer varias preguntas: se hacen de a una en la misma espera y `responder` va juntando.
      const p = preguntas[0];
      return this.esperar(
        ev.session_id,
        'pregunta',
        textoPregunta(p),
        (id) => botonesPregunta(id, p, new Set()),
        { toolInput: ev.tool_input, preguntas, marcadas: new Set(), indice: 0, respuestas: {} },
        señal
      );
    }
    return {};
  }

  private async esperar(
    sessionId: string,
    tipo: Espera['tipo'],
    texto: string,
    botones?: (id: string) => ReturnType<typeof botonesPermiso>,
    extra: Partial<Espera> = {},
    señal?: AbortSignal
  ): Promise<object> {
    if (señal?.aborted) return {};
    const id = randomBytes(4).toString('hex');
    const mensajeId = await this.enviarConReintento(sessionId, texto, botones?.(id), señal);
    if (mensajeId === null) return {};
    return new Promise<object>((resolver) => {
      const espera: Espera = { id, sessionId, tipo, mensajeId, resolver, ...extra };
      this.esperas.set(id, espera);
      // Mientras se mandaba el mensaje pudo abortarse el hook o volver el usuario a la PC (y `soltarTodo` no
      // vio esta espera, todavía no estaba en el mapa): ya está en Telegram, así que se lo retoma igual.
      if (señal?.aborted || (!this.d.fuera() && !espera.enPC)) return void this.retomar(espera);
      señal?.addEventListener('abort', () => void this.retomar(espera), { once: true });
    });
  }

  /**
   * Manda al tema de la sesión. Un tema borrado a mano se recrea una vez. Sin
   * red o con un 429 (demasiados mensajes) se reintenta con espera creciente
   * (hasta 60 s, o lo que pida Telegram) mientras siga el modo fuera; si el
   * usuario vuelve (o Claude Code mató el hook), devuelve null y la terminal se
   * encarga.
   */
  private async enviarConReintento(
    sessionId: string,
    texto: string,
    botones?: ReturnType<typeof botonesPermiso>,
    señal?: AbortSignal
  ): Promise<number | null> {
    const v = this.d.vinculo()!;
    for (let intento = 0; ; intento++) {
      try {
        const tema = await this.temaDe(sessionId);
        // Sin botones es un fin de turno: trae lo que escribió el agente, en Markdown.
        return await this.d.canal.enviar(v.chatId, texto, { tema, botones, md: !botones });
      } catch (e) {
        if (e instanceof TelegramError && e.codigo === 400 && /thread/i.test(e.message) && intento === 0) {
          await this.d.temas.borrar(sessionId);
          continue;
        }
        if (e instanceof TelegramError && e.codigo !== 429) throw e;
        const pedida = e instanceof TelegramError && e.reintentarSeg ? e.reintentarSeg * 1000 : 0;
        await new Promise((r) => setTimeout(r, Math.min(60_000, pedida || (this.d.esperaReintentoMs ?? 1000) * 2 ** intento)));
        if (!this.d.fuera() || señal?.aborted) return null;
      }
    }
  }

  private resolver(e: Espera, r: object): void {
    this.esperas.delete(e.id);
    e.resolver(r);
  }

  /** Suelta una espera con `{}` y marca su mensaje; si ya la resolvió otro camino, no hace nada. */
  private async retomar(e: Espera): Promise<void> {
    if (!this.esperas.has(e.id)) return;
    this.resolver(e, {});
    const v = this.d.vinculo();
    if (v) await this.d.canal.editar(v.chatId, e.mensajeId, '✋ Retomado en la PC.').catch(() => {});
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

  /**
   * Primero se sueltan todas, sin esperar nada: un `editar` colgado (red lenta) no puede dejar a la
   * segunda espera trabando su terminal. Los "Retomado" salen después y nadie los espera.
   */
  soltarTodo(conservarEscuchas = false): void {
    // Al volver de "fuera" se sueltan permisos y preguntas (vuelven a la terminal); los Stop de sesiones
    // que se usan desde Telegram siguen escuchando, como si ya hubieran empezado en la PC.
    const soltadas = [...this.esperas.values()].filter(
      (e) => !(conservarEscuchas && e.tipo === 'stop' && this.d.temas.leer(e.sessionId) !== undefined)
    );
    for (const e of soltadas) this.resolver(e, {});
    const v = this.d.vinculo();
    if (v) void Promise.allSettled(soltadas.map((e) => this.d.canal.editar(v.chatId, e.mensajeId, '✋ Retomado en la PC.')));
  }

  async atenderUpdate(u: Update): Promise<void> {
    const v = this.d.vinculo();
    if (u.callback_query) {
      const cb = u.callback_query;
      // Sólo el usuario vinculado y desde el chat vinculado (spec §8).
      if (!v || cb.from.id !== v.userId || cb.message?.chat.id !== v.chatId) return;
      const dato = leerDato(cb.data ?? '');
      const e = dato && this.esperas.get(dato.id);
      if (!dato || !e) {
        // Una espera que ya no existe (se reinició la app, o se contestó en la PC): el aviso del botón dura un
        // instante y se pierde, así que el mensaje mismo lo dice y se queda sin botones.
        if (cb.message) {
          const nota = '⌛ Ya no está vigente (se contestó en la PC o se reinició la app). Si la sesión sigue esperando, contestala en la consola.';
          void this.d.canal.editar(v.chatId, cb.message.message_id, `${cb.message.text ?? ''}\n\n${nota}`.trim()).catch(() => {});
        }
        return void (await this.d.canal.contestarBoton(cb.id, 'Ya no está vigente.'));
      }
      // Primero se toma la decisión y recién después se avisa al botón, sin esperarlo: si ese aviso falla
      // (red caída, botón vencido) la respuesta ya quedó aplicada y el hook no se traba.
      const trabajo =
        e.tipo === 'permiso'
          ? this.decidirPermiso(e, dato.accion === 'si', v.chatId)
          : e.tipo === 'pregunta'
            ? this.botonPregunta(e, dato.accion)
            : undefined;
      void this.d.canal.contestarBoton(cb.id).catch(() => {});
      return trabajo;
    }
    const m = u.message;
    if (!m) return;
    if (!v) return this.intentarVincular(m);
    if (m.chat.id !== v.chatId || m.from?.id !== v.userId) return;
    const texto = (m.text ?? m.caption ?? '').trim();
    if (texto === '/fuera' || texto.startsWith('/fuera@')) return this.d.setManual(true);
    if (texto === '/vuelvo' || texto.startsWith('/vuelvo@')) return this.d.setManual(false);
    // Voz, stickers, documentos y mensajes de servicio no traen nada que pasarle a una sesión: sin esto
    // un sticker respondería la espera con texto vacío.
    if (!texto && !m.photo?.length) {
      return void (await this.d.canal.enviar(v.chatId, 'Por ahora sólo entiendo texto y fotos.', { tema: m.message_thread_id }));
    }
    const sessionId = m.is_topic_message && m.message_thread_id ? this.d.temas.sesionDe(m.message_thread_id) : undefined;
    if (texto.startsWith('/estado')) return this.estado(v, m.message_thread_id, sessionId);
    if (!sessionId) return void (await this.d.canal.enviar(v.chatId, AYUDA, { tema: m.message_thread_id }));
    const cambio = leerCambioModelo(texto);
    if (cambio) return this.pedirCambio(sessionId, cambio);
    if (m.photo?.length) return this.foto(sessionId, m, texto);
    return this.aSesion(sessionId, texto, [], m.message_id);
  }

  /**
   * La espera ya salió de `esperas`, así que un segundo toque cae en "Ya no está vigente". Igual se sacan los botones
   * (editar sin `reply_markup`): permitido, el mensaje se borra; rechazado, queda marcado.
   */
  private decidirPermiso(e: Espera, permitir: boolean, chatId: number): void {
    this.resolver(e, respuestaPermiso(permitir));
    const quitar =
      permitir && this.d.canal.borrar
        ? this.d.canal.borrar(chatId, e.mensajeId)
        : this.d.canal.editar(chatId, e.mensajeId, permitir ? '✅ Permitido.' : '❌ Rechazado.');
    void quitar.catch(() => {});
  }

  private async botonPregunta(e: Espera, accion: string): Promise<void> {
    if (e.avanzando) return;
    const p = e.preguntas![e.indice!];
    const respuestas = (valor: string) => this.responder(e, valor);
    // Orden numérico: el `.sort()` por defecto compara como texto y pone el 10 antes que el 2.
    if (accion === 'listo') return respuestas([...e.marcadas!].sort((a, b) => a - b).map((i) => p.options[i].label).join(', '));
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

  /** Guarda la respuesta a la pregunta en curso: con otra pendiente la manda, y con la última suelta el hook con todas. */
  private async responder(e: Espera, valor: string): Promise<void> {
    const i = e.indice!;
    const p = e.preguntas![i];
    e.respuestas = { ...e.respuestas, [p.question]: valor };
    const sig = e.preguntas![i + 1];
    const v = this.d.vinculo()!;
    // Sin botones y con la respuesta a la vista: un segundo toque no tiene dónde caer.
    const marcar = () => this.d.canal.editar(v.chatId, e.mensajeId, `${textoPregunta(p)}\n\n✔ ${valor}`).catch(() => {});
    if (!sig) {
      this.resolver(e, respuestaPregunta(e.toolInput!, e.respuestas));
      return void marcar();
    }
    e.avanzando = true;
    await marcar();
    e.indice = i + 1;
    e.marcadas = new Set();
    try {
      e.mensajeId = await this.d.canal.enviar(v.chatId, textoPregunta(sig), {
        tema: this.d.temas.leer(e.sessionId),
        botones: botonesPregunta(e.id, sig, e.marcadas)
      });
    } finally {
      e.avanzando = false;
    }
  }

  /** Lo escrito en el tema de una sesión: responde lo que esté esperando, y si no, la toma o lo guarda. */
  /** `trabajando`: la sesión ya está (o se pone) a trabajar con esto; si no, sólo quedó guardado. */
  private entregado(sessionId: string, mensajeId?: number, trabajando = true): void {
    if (mensajeId !== undefined) this.d.alEntregar?.(sessionId, mensajeId, trabajando);
  }

  private async aSesion(sessionId: string, texto: string, imagenes: string[], mensajeId?: number): Promise<void> {
    const pendientes = [...this.esperas.values()].filter((e) => e.sessionId === sessionId);
    const pregunta = pendientes.find((e) => e.tipo === 'pregunta');
    if (pregunta && texto) {
      // Justo pasando a la pregunta siguiente (un editar y un enviar): se le da ese momento, o el texto caería en el
      // turno como si fuera un mensaje suelto y la pregunta quedaría sin responder.
      for (let i = 0; pregunta.avanzando && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
      if (!pregunta.avanzando && this.esperas.has(pregunta.id)) {
        void this.responder(pregunta, texto).catch((e) => this.d.alError?.(e));
        return this.entregado(sessionId, mensajeId);
      }
    }
    const stop = pendientes.find((e) => e.tipo === 'stop');
    if (stop) {
      this.resolver(stop, respuestaStop(texto, imagenes));
      return this.entregado(sessionId, mensajeId);
    }
    const a = (await this.d.sesiones()).find((s) => s.sessionId === sessionId);
    const v = this.d.vinculo()!;
    const tema = this.d.temas.leer(sessionId);
    if (!a) return void (await this.d.canal.enviar(v.chatId, 'Esa sesión terminó.', { tema }));
    // En la PC la consola es del usuario: tomarla la cerraría. Queda guardado para su próximo paso o turno.
    if (a.estado === 'esperando' && this.d.fuera()) {
      // Tomarla es cerrar su proceso: a Desktop no se le puede hacer eso.
      if (a.origen === 'desktop') return void (await this.d.canal.enviar(v.chatId, 'Es una sesión de Desktop: contestala en Desktop.', { tema }));
      // Tomada, la sesión recibe el texto como un prompt común (no como feedback de hook): va sin prefijo.
      // Sin esperar el turno: `escuchar` espera cada update, y mientras dura el turno (minutos) el bot quedaría
      // sordo, incluso al botón de un permiso que pide ese mismo turno.
      void this.d.tomar(sessionId, conImagenes(texto, imagenes)).catch((e) => this.d.alError?.(e));
      return this.entregado(sessionId, mensajeId);
    }
    // En la PC, quieta no escucha Telegram (recién compactada, o nunca tomó turno): se la reabre en su consola,
    // a la vista, con el mensaje de primero. Toma turno y al terminar vuelve a escuchar acá.
    if (a.estado === 'esperando' && a.origen !== 'desktop') {
      this.aplicarCambio(sessionId, { mensaje: conImagenes(texto, imagenes) });
      return this.entregado(sessionId, mensajeId);
    }
    this.guardado.set(sessionId, [this.guardado.get(sessionId), conImagenes(texto, imagenes)].filter(Boolean).join('\n'));
    // Quieta y sin escuchar (recién abierta, o se cortó la espera con Esc): no está trabajando, no hay que
    // mostrar "escribiendo…"; le llega en cuanto haga algo.
    const quieta = a.estado === 'esperando';
    this.entregado(sessionId, mensajeId, !quieta);
    const aviso = await this.d.canal.enviar(
      v.chatId,
      quieta
        ? 'Recibido. Es una sesión de Desktop quieta y todavía no escucha Telegram: le llega en cuanto haga algo. Para que escuche, escribile una vez en Desktop.'
        : 'Recibido: se lo paso en su próximo paso.',
      { tema }
    );
    this.transitorios.set(sessionId, [...(this.transitorios.get(sessionId) ?? []), aviso]);
  }

  /** /model o /effort: con la sesión quieta se aplica ya; trabajando, en el Stop de este turno. */
  private async pedirCambio(sessionId: string, cambio: CambioModelo | { error: string }): Promise<void> {
    const v = this.d.vinculo()!;
    const tema = this.d.temas.leer(sessionId);
    const decir = (t: string) => this.d.canal.enviar(v.chatId, t, { tema });
    if ('error' in cambio) return void (await decir(cambio.error));
    const a = (await this.d.sesiones()).find((s) => s.sessionId === sessionId);
    if (!a) return void (await decir('Esa sesión terminó.'));
    if (a.origen === 'desktop') return void (await decir('Es una sesión de Desktop: cambiale el modelo en Desktop.'));
    const pendientes = [...this.esperas.values()].filter((e) => e.sessionId === sessionId);
    const escucha = pendientes.find((e) => e.tipo === 'stop');
    if (escucha || (a.estado === 'esperando' && !pendientes.length)) {
      // Escuchando: se suelta el Stop sin más (su mensaje final queda) y después se cierra el proceso.
      if (escucha) this.resolver(escucha, {});
      return this.aplicarCambio(sessionId, cambio);
    }
    this.cambios.set(sessionId, cambio);
    await decir(`Lo aplico cuando termine este turno: ${describirCambio(cambio)}.`);
  }

  /** Sin esperarlo: tarda (cerrar, reabrir) y el bot no puede quedarse sordo mientras. */
  private aplicarCambio(sessionId: string, cambio: CambioModelo): void {
    const v = this.d.vinculo();
    if (!v) return;
    const tema = this.d.temas.leer(sessionId);
    const decir = (t: string) => this.d.canal.enviar(v.chatId, t, { tema });
    setTimeout(() => {
      void this.d
        .cambiarModelo(sessionId, cambio)
        // Sin confirmar: con modelo, esfuerzo o un mensaje la sesión contesta sola ("Terminó y te espera"), y al
        // compactar lo muestran el reloj del PreCompact y el cierre del PostCompact.
        .catch((e) =>
          decir(`⚠️ No pude ${cambio.mensaje !== undefined ? 'pasárselo' : 'cambiarla'}: ${e instanceof Error ? e.message : String(e)}`)
        )
        .catch((e) => this.d.alError?.(e));
    }, this.d.esperaCambioMs ?? 1500);
  }

  /**
   * Empieza a compactar (desde Telegram, a mano o sola): en el tema, un mensaje con reloj que se edita hasta
   * el PostCompact. Los tokens se ven al final: la compactación es una sola llamada, no hay avance intermedio.
   */
  private empezarCompactar(sessionId: string): object {
    const v = this.d.vinculo();
    const tema = this.d.temas.leer(sessionId);
    if (!v || tema === undefined || this.compactando.has(sessionId)) return {};
    const desde = Date.now();
    const mensajeId = this.d.canal.enviar(v.chatId, textoCompactando(0), { tema });
    const c = {
      mensajeId,
      desde,
      cola: mensajeId.then(() => {}, () => {}),
      timer: setInterval(() => {
        const ms = Date.now() - desde;
        if (ms > MAX_RELOJ_MS) return void this.pararReloj(sessionId);
        // En fila: una edición del reloj que llegara después del cierre lo taparía.
        c.cola = c.cola.then(() => mensajeId.then((id) => this.d.canal.editar(v.chatId, id, textoCompactando(ms)))).catch(() => {});
      }, this.d.relojCompactarMs ?? 5000)
    };
    this.compactando.set(sessionId, c);
    mensajeId.catch(() => this.pararReloj(sessionId));
    return {};
  }

  private pararReloj(sessionId: string) {
    const c = this.compactando.get(sessionId);
    if (c) clearInterval(c.timer);
    this.compactando.delete(sessionId);
    return c;
  }

  /** Terminó de compactar: aviso en la consola siempre, y en el tema (sobre el reloj, si lo hay) cuando tiene uno. */
  private async avisarCompactado(sessionId: string, transcript?: string): Promise<object> {
    const c = this.pararReloj(sessionId);
    const datos = transcript ? await this.d.compactacion?.(transcript).catch(() => null) : null;
    const texto = textoCompactado(c ? Date.now() - c.desde : null, datos ?? null);
    const v = this.d.vinculo();
    const tema = this.d.temas.leer(sessionId);
    if (v && tema !== undefined) {
      const enviar = () => this.d.canal.enviar(v.chatId, texto, { tema });
      const editar = (c: { cola: Promise<void>; mensajeId: Promise<number> }) =>
        c.cola.then(() => c.mensajeId).then((id) => this.d.canal.editar(v.chatId, id, texto));
      void (c ? editar(c).catch(enviar) : enviar()).catch(() => {});
    }
    return { systemMessage: texto };
  }

  private limpiarTransitorios(sessionId: string): void {
    const ids = this.transitorios.get(sessionId);
    const v = this.d.vinculo();
    this.transitorios.delete(sessionId);
    if (!ids || !v || !this.d.canal.borrar) return;
    for (const id of ids) void this.d.canal.borrar(v.chatId, id).catch(() => {});
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
      mensajeId: m.message_id,
      timer: setTimeout(() => {
        this.albumes.delete(clave);
        // Nadie espera este temporizador: un rechazo acá quedaría "unhandled" en el proceso principal.
        this.aSesion(nuevo.sessionId, nuevo.texto || 'Mirá las imágenes.', nuevo.fotos, nuevo.mensajeId).catch((e) => this.d.alError?.(e));
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

  /**
   * Sin vínculo, cualquiera que encuentre el bot puede probar códigos: son 6 cifras y valen 10 minutos.
   * Al quinto código equivocado se quema el vigente (hay que pedir otro en la app) y queda anotado.
   * Sin respuesta al que erró: no se le confirma ni que hay un código en juego.
   */
  private async intentarVincular(m: Mensaje): Promise<void> {
    const c = this.d.codigo();
    const pedido = /^\/vincular(?:@\S+)?\s+(\d{6})$/.exec((m.text ?? '').trim());
    if (!c || !pedido || !m.from || Date.now() > c.vence) return;
    if (pedido[1] !== c.codigo) {
      if (this.fallosCodigo.codigo !== c.codigo) this.fallosCodigo = { codigo: c.codigo, n: 0 };
      if (++this.fallosCodigo.n >= 5) {
        this.d.quemarCodigo?.({ userId: m.from.id, chatId: m.chat.id });
        this.fallosCodigo = { codigo: '', n: 0 };
      }
      return;
    }
    // Sin Temas no hay un hilo por sesión: todo se mezclaría. El código no se gasta, sirve en el grupo bueno.
    if (m.chat.type !== 'supergroup' || m.chat.is_forum !== true) {
      return void (await this.d.canal.enviar(m.chat.id, 'Usá un grupo con Temas activados.', { tema: m.message_thread_id }));
    }
    await this.d.vincular({ chatId: m.chat.id, userId: m.from.id });
    await this.d.canal.enviar(m.chat.id, `Listo: quedó vinculado.\n\n${AYUDA}`, { tema: m.message_thread_id });
  }
}
