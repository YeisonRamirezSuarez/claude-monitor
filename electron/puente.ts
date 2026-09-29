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
import { TelegramError, type Mensaje, type Telegram, type Update } from './telegram';

export type Canal = Pick<Telegram, 'enviar' | 'editar' | 'contestarBoton' | 'crearTema' | 'descargar'> &
  Partial<Pick<Telegram, 'borrar'>>;
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
  /** Un Stop que escucha Telegram estando el usuario en la PC: no se suelta al volver de "fuera". */
  enPC?: boolean;
};

const AYUDA =
  'Cada sesión tiene su tema: escribí ahí para contestarle.\n/estado — cómo va cada sesión\n/fuera · /vuelvo — forzar el modo fuera';

export class Puente {
  private esperas = new Map<string, Espera>();
  /** Lo que se le escribió a una sesión que estaba trabajando: va en su próximo Stop. */
  private guardado = new Map<string, string>();
  /** Avisos del bot que sobran cuando llega la respuesta ("Recibido: …"): se borran para que quede sólo la respuesta. */
  private transitorios = new Map<string, number[]>();
  private creandoTema = new Map<string, Promise<number>>();
  private albumes = new Map<string, { sessionId: string; texto: string; fotos: string[]; mensajeId: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private d: DepsPuente) {}

  /**
   * `señal` la aborta el endpoint cuando Claude Code mató el hook (el usuario apretó
   * Esc o contestó en la terminal): esa espera ya no tiene a quién responderle.
   */
  async atenderHook(ev: EventoHook, señal?: AbortSignal): Promise<object> {
    if (ev.hook_event_name === 'SessionStart') return contextoInicio();
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
      // Una espera por pregunta sería lo ideal; AskUserQuestion casi siempre trae
      // una. ponytail: con varias se contesta sólo la primera y el resto queda vacío.
      const p = preguntas[0];
      return this.esperar(
        ev.session_id,
        'pregunta',
        textoPregunta(p),
        (id) => botonesPregunta(id, p, new Set()),
        { toolInput: ev.tool_input, preguntas, marcadas: new Set() },
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
      if (!dato || !e) return void (await this.d.canal.contestarBoton(cb.id, 'Ya no está vigente.'));
      // Primero se toma la decisión y recién después se avisa al botón, sin esperarlo: si ese aviso falla
      // (red caída, botón vencido) la respuesta ya quedó aplicada y el hook no se traba.
      const trabajo =
        e.tipo === 'permiso'
          ? this.resolver(e, respuestaPermiso(dato.accion === 'si'))
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
    if (m.photo?.length) return this.foto(sessionId, m, texto);
    return this.aSesion(sessionId, texto, [], m.message_id);
  }

  private async botonPregunta(e: Espera, accion: string): Promise<void> {
    const p = e.preguntas![0];
    const respuestas = (valor: string) => this.resolver(e, respuestaPregunta(e.toolInput!, { [p.question]: valor }));
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

  /** Lo escrito en el tema de una sesión: responde lo que esté esperando, y si no, la toma o lo guarda. */
  /** `trabajando`: la sesión ya está (o se pone) a trabajar con esto; si no, sólo quedó guardado. */
  private entregado(sessionId: string, mensajeId?: number, trabajando = true): void {
    if (mensajeId !== undefined) this.d.alEntregar?.(sessionId, mensajeId, trabajando);
  }

  private async aSesion(sessionId: string, texto: string, imagenes: string[], mensajeId?: number): Promise<void> {
    const pendientes = [...this.esperas.values()].filter((e) => e.sessionId === sessionId);
    const pregunta = pendientes.find((e) => e.tipo === 'pregunta');
    if (pregunta && texto) {
      this.resolver(pregunta, respuestaPregunta(pregunta.toolInput!, { [pregunta.preguntas![0].question]: texto }));
      return this.entregado(sessionId, mensajeId);
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
    this.guardado.set(sessionId, [this.guardado.get(sessionId), conImagenes(texto, imagenes)].filter(Boolean).join('\n'));
    // Quieta y sin escuchar (recién abierta, o se cortó la espera con Esc): no está trabajando, no hay que
    // mostrar "escribiendo…"; le llega en cuanto haga algo.
    const quieta = a.estado === 'esperando';
    this.entregado(sessionId, mensajeId, !quieta);
    const aviso = await this.d.canal.enviar(
      v.chatId,
      quieta
        ? 'Recibido. La sesión está quieta en la consola y todavía no escucha Telegram: le llega en cuanto haga algo. Para que escuche, escribile una vez en la consola (o mandá /fuera).'
        : 'Recibido: se lo paso en su próximo paso.',
      { tema }
    );
    this.transitorios.set(sessionId, [...(this.transitorios.get(sessionId) ?? []), aviso]);
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

  private async intentarVincular(m: Mensaje): Promise<void> {
    const c = this.d.codigo();
    const pedido = /^\/vincular(?:@\S+)?\s+(\d{6})$/.exec((m.text ?? '').trim());
    if (!c || !pedido || !m.from || Date.now() > c.vence || pedido[1] !== c.codigo) return;
    // Sin Temas no hay un hilo por sesión: todo se mezclaría. El código no se gasta, sirve en el grupo bueno.
    if (m.chat.type !== 'supergroup' || m.chat.is_forum !== true) {
      return void (await this.d.canal.enviar(m.chat.id, 'Usá un grupo con Temas activados.', { tema: m.message_thread_id }));
    }
    await this.d.vincular({ chatId: m.chat.id, userId: m.from.id });
    await this.d.canal.enviar(m.chat.id, `Listo: quedó vinculado.\n\n${AYUDA}`, { tema: m.message_thread_id });
  }
}
