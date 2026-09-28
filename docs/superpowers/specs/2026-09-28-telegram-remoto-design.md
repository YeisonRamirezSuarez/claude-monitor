# Telegram remoto — diseño

Fecha: 2026-09-28
Estado: diseño aprobado por partes en conversación (2026-09-28). Pendiente:
revisión de esta especificación y plan de implementación.
Alcance: seguir y manejar desde Telegram las sesiones de Claude Code de todas
las cuentas cuando el usuario no está en la PC.

---

## 1. Problema

La PC (un portátil) queda prendida todo el día con la tapa cerrada. Mientras el
usuario no está, sus agentes se frenan en tres puntos y nadie los destraba:

- piden **permiso** para una herramienta;
- hacen una **pregunta** (`AskUserQuestion`);
- **terminan su turno** y esperan una instrucción nueva.

Además no hay forma de ver **cómo va** cada trabajo. Lo que se busca: un aviso en
el celular, contestar desde ahí (texto, botones o una imagen) y que el agente
siga.

### Por qué no alcanza lo que ya existe

`claude --remote-control` resuelve la mitad, pero en esta cuenta la política de
la organización lo bloquea (`Remote Control is disabled by your organization's
policy`). Aunque no lo bloqueara, cada cuenta vería sólo sus sesiones, y el
usuario tiene seis. claude-monitor ya conoce las sesiones de todas las cuentas:
es el lugar natural.

### Excluido

- WhatsApp u otros canales.
- Varios usuarios por instalación: cada compañero usa su propio bot.
- Abrir sesiones nuevas desde Telegram.
- Mandar avisos de avance sin que se pidan (sólo los tres eventos de §5.2).
- Cuentas de WSL (su Claude corre adentro de la distro; el hook de Windows no
  llega). Quedan igual que hoy.

## 2. Lo que se midió (prueba del 2026-09-28)

Con hooks cargados por `--settings` en un archivo temporal, modelo `haiku`,
en modo `-p` y en una terminal interactiva real (manejada con el `node-pty` de
VS Code):

| Pregunta | Resultado |
|---|---|
| `PermissionRequest` → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | ✅ el Bash corrió sin preguntar |
| `PreToolUse` sobre `AskUserQuestion` con `updatedInput.answers` | ✅ en interactivo: la terminal mostró `¿Cuál es tu color favorito? → Verde`, sin menú. ❌ en `-p` la herramienta no existe |
| `Stop` que espera y devuelve `{"decision":"block","reason":…}` | ✅ esperó 90 s y el agente siguió con el texto |
| El agente confía en el texto que llega por `Stop` | ❌ sin contexto lo marcó como inyección. ✅ con un `SessionStart` que devuelve `additionalContext` explicando el puente |
| Qué ve la terminal mientras `Stop` espera | `running Stop hooks… 0/2 · 6s` con contador. Lo que se escribe queda en cola (`Press up to edit queued messages`). `Esc` corta la espera (`Interrupted`) y procesa lo escrito |
| Un hook que falla | Claude Code lo toma como "non-blocking" y la sesión sigue |

La respuesta del puente se muestra en la terminal como `Stop hook error: [...]`;
es sólo el rótulo de Claude Code.

## 3. Decisiones de producto

| Tema | Decisión |
|---|---|
| Canal | Telegram, con un bot propio de cada usuario |
| Qué se puede hacer | ver estado y avance, aprobar o rechazar permisos, responder preguntas, dar instrucciones nuevas, mandar imágenes |
| Cómo se separan las sesiones | un grupo privado con **Temas**: un tema por sesión |
| Cuándo se activa | "modo fuera" automático (tapa cerrada, inactividad) más manual |
| Sesión que ya estaba quieta al irse | la app **la toma**: cierra su `claude` y la sigue sin terminal (§6) |
| Configuración | una sección en la app, porque la app se reparte al equipo |

## 4. Arquitectura

Todo corre dentro de claude-monitor (Electron). No hay servidor externo ni
puertos abiertos hacia afuera: el bot hace long polling a la API de Telegram
desde la PC.

```
 Claude Code (cada sesión)            claude-monitor (proceso main)                    Telegram
 ┌──────────────────────┐   POST     ┌─────────────────────────────────────────┐   HTTPS   ┌────────┐
 │ hook remoto-hook.js  │──────────▶ │ endpoint 127.0.0.1 (token)              │           │  bot   │
 │ PermissionRequest    │ ◀──────────│   └─ puente.ts ── telegram.ts ──────────┼─────────▶ │ grupo  │
 │ PreToolUse(AskUser…) │  respuesta │        ▲    └─ presencia.ts             │ ◀─────────│ temas  │
 │ Stop · SessionStart  │            │        └── tomar.ts (claude -p --resume)│ getUpdates└────────┘
 └──────────────────────┘            └─────────────────────────────────────────┘
```

### 4.1 Piezas

Cada una en su propio archivo de `electron/`, con una sola responsabilidad:

| Archivo | Qué hace | De qué depende |
|---|---|---|
| `telegram.ts` | Cliente mínimo de la Bot API: `getUpdates` (long polling), `sendMessage`, `editMessageText`, `answerCallbackQuery`, `createForumTopic`, `getFile` y la descarga del archivo. Botones inline. Recorta el texto a 4096 caracteres. | `fetch`; ninguna dependencia nueva |
| `puente.ts` | Recibe los eventos de los hooks. Si el modo fuera está activo, los manda al tema de su sesión, espera la respuesta y la traduce al JSON del hook. Guarda qué tema es de qué sesión (`%APPDATA%\claude-monitor\telegram.json`). Atiende los comandos. | `telegram.ts`, `presencia.ts`, `tomar.ts`, `oficina.ts` (`agentesVivos`, `conversacionDe`), `nombres.ts` |
| `presencia.ts` | Decide si el usuario está fuera (§7) y avisa cada cambio. | `powerMonitor`; el ayudante de la tapa |
| `tomar.ts` | Toma una sesión quieta y corre sus turnos sin terminal (§6). | `child_process`, el registro `sessions/` |
| `remoto-hook.js` | El script del hook. Lee el evento, le hace POST al endpoint local y escribe la respuesta. Si la app no contesta, sale con `{}`. | `node` |
| `src/…` Configuración | La sección "Telegram" de la app (§9). | IPC nuevo |

### 4.2 Endpoint local

- Escucha en `127.0.0.1` en un puerto al azar. Un token aleatorio va en
  `%APPDATA%\claude-monitor\remoto.json` (`{ port, token }`), que el hook lee en
  cada evento. Es el mismo esquema que `~/.pixel-agents/server.json`.
- Una sola ruta: `POST /hook` con el evento crudo y `Authorization: Bearer
  <token>`. La respuesta es el JSON que el hook tiene que escribir.
- Si el puente está apagado o no hay modo fuera, contesta `{}` enseguida.

### 4.3 Instalación del hook

- Se instala recién cuando el usuario activa Telegram en la configuración, y se
  saca al desactivarlo.
- Va en el `settings.json` del pozo (la cuenta principal). Desde ahí lo
  reparte el `syncAllPlugins` que la app ya tiene: `syncPlugins` pisa la clave
  `hooks` de cada cuenta con la del pozo (`plugins.ts`, `PLUGIN_KEYS`), así que
  instalarlo cuenta por cuenta no duraría.
- El script se copia a `%APPDATA%\claude-monitor\hooks\remoto-hook.js`, como
  hace Pixel Agents con el suyo.
- Eventos: `PermissionRequest` (`*`), `PreToolUse` (`AskUserQuestion`), `Stop`
  (`*`) y `SessionStart` (`*`). Todos con `timeout: 86400`.
- Costo con el puente inactivo: unos 100 ms por evento, lo que tarda en
  arrancar `node`.

## 5. Flujo de mensajes

### 5.1 Temas

- El bot abre el tema de una sesión la primera vez que tiene algo que mandarle.
- Nombre: `carpeta · nombre de la sesión · cuenta` (por ejemplo
  `VendigMachine · migracion MAX`). Usa `nombrePropio` de `nombres.json` si el
  usuario le puso uno.
- El tema "General" es para comandos y resúmenes.
- Si el tema se borra a mano, se crea otro en el próximo mensaje.

### 5.2 Eventos con el modo fuera activo

| Evento | Qué manda | Qué acepta | Qué le devuelve al hook |
|---|---|---|---|
| `PermissionRequest` | 🔐 herramienta y detalle (comando, archivo), recortado | botones **✅ Permitir** / **❌ Rechazar** | `decision.behavior: "allow"` o `"deny"` |
| `PreToolUse` `AskUserQuestion` | ❓ la pregunta y un botón por opción; si es de varias, botones marcables y **Listo** | botón, o texto libre (equivale a "Otro") | `permissionDecision: "allow"` más `updatedInput` con `answers` |
| `Stop` | ✅ el último mensaje del agente, recortado | texto, foto o álbum | `decision: "block"`, `reason: "[claude-monitor · Telegram] El usuario respondió: …"` |
| `SessionStart` | nada | — | `additionalContext` que explica el puente (§8) |

- Las imágenes se descargan a
  `%LOCALAPPDATA%\claude-monitor\telegram\<sessionId>\` y se le pasan al
  agente como rutas dentro del `reason`; el agente las abre con Read. Un álbum
  se junta durante 2 s y va en un solo mensaje.
- Los subagentes no frenan ni mandan mensajes (su fin es `SubagentStop`, que
  no se engancha). Aparecen en `/estado`.
- Una sesión con `stop_hook_active: true` (ya reanudada por este mismo hook)
  vuelve a esperar normalmente: cada turno termina en una espera nueva.

### 5.3 Comandos

| Comando | Dónde | Qué hace |
|---|---|---|
| `/estado` | General | Las sesiones vivas de todas las cuentas, con su estado (trabajando, te espera, pide permiso, quieta) y su última actividad. Sale de `agentesVivos` |
| `/estado` | un tema | El detalle de esa sesión: estado, último mensaje y subagentes |
| `/fuera` · `/vuelvo` | cualquiera | Fuerzan el modo fuera (§7) |

### 5.4 Al volver a la PC

Cuando el modo fuera se apaga:

- toda espera pendiente del puente se suelta con `{}`. Los permisos vuelven a
  aparecer en la terminal como siempre, y las esperas de `Stop` terminan sin
  instrucción;
- los mensajes de Telegram que esperaban respuesta se editan a "✋ Retomado en
  la PC" y pierden sus botones.

## 6. Sesiones que ya estaban quietas: "tomar"

Una sesión que terminó su turno antes de que empezara el modo fuera ya no está
en una espera de `Stop`, así que no hay por dónde meterle un mensaje. Es el caso
más común: el usuario termina, la sesión queda esperándolo y recién después
cierra la tapa.

Cuando llega un mensaje al tema de una sesión así:

1. Se verifica que esté quieta: `status` del registro `sessions/<pid>.json` en
   espera de input, y el transcript sin un turno en curso. Si está trabajando,
   no se toma: el mensaje queda para su próximo `Stop`.
2. Se cierra su proceso `claude` (el pid del registro, después de verificar
   `procStart` como en `mismoInicio`). La ventana de la terminal queda abierta
   y muestra que terminó. No se pierde nada, porque todo está en el transcript.
3. El turno corre con `claude -p --chrome --resume <id> --output-format
   stream-json "<mensaje>"`, en el `cwd` de la sesión y con su
   `CLAUDE_CONFIG_DIR`. Los permisos pasan por el mismo hook. El texto del
   agente se va mandando al tema a medida que llega.
4. Cada mensaje siguiente es otro turno `-p --resume`. No corren dos a la vez
   sobre la misma sesión: el segundo mensaje espera a que termine el primero.
5. En este modo no existe `AskUserQuestion`: el agente pregunta en texto y se le
   contesta en el mismo tema.
6. Al volver, la app muestra "Continuadas desde Telegram" con **Reabrir en
   terminal** (`claude --chrome --resume <id>`, lo mismo que `sessions:resume`).

## 7. Modo fuera

Se evalúa en este orden; el primero que da resultado manda:

1. **Manual:** `/fuera` y `/vuelvo`, o el interruptor de la app. Queda fijo
   hasta que se cambie a mano o hasta el próximo cambio de la tapa.
2. **Tapa:** Windows avisa con `GUID_LIDSWITCH_STATE_CHANGE` (evento de energía).
   Electron no lo expone. Un ayudante en PowerShell con `Add-Type` (C#) crea
   una ventana oculta, llama a `RegisterPowerSettingNotification` y escribe
   `lid 0` o `lid 1` por stdout. La app lo lanza al arrancar y lo cierra con
   ella (como el servidor de Pixel Agents). Si el ayudante no arranca o el
   equipo no tiene tapa, se sigue con el punto 3.
   **Antes de implementar hay que probar que el portátil del usuario emite el
   evento con la tapa cerrada y la acción "No hacer nada".**
3. **Inactividad:** `powerMonitor.getSystemIdleTime()` ≥ N minutos (por defecto
   10, configurable). Se revisa cada 30 s. Con la tapa cerrada también se
   cumple, así que cubre el caso aunque falle el punto 2.

Cualquier uso del teclado o el mouse (la inactividad vuelve a menos de 1 min)
apaga el modo fuera, salvo si es manual. Cada cambio aplica §5.4.

## 8. Seguridad y privacidad

- **Sólo el dueño:** se acepta el chat vinculado y, dentro de él, sólo el
  `from.id` de quien lo vinculó. Todo lo demás se ignora sin contestar.
- **Vinculación:** la app muestra un código de 6 dígitos. Es de un solo uso,
  vence a los 10 minutos y se le manda al bot desde el grupo con `/vincular
  <código>`. Ahí quedan fijos el `chat_id` y el `from.id`.
- **Token del bot:** se cifra con `safeStorage` de Electron y nunca va al
  registro (`anotar`).
- **Botones:** el `callback_data` lleva el id de la solicitud. Un botón de una
  espera ya resuelta o soltada contesta "ya no está vigente" y no hace nada.
- **Endpoint local:** sólo en `127.0.0.1`, con token. Un evento sin token o con
  otro token se rechaza con 401.
- **Contexto de confianza (`SessionStart`):** dice que el puente lo configuró
  el usuario y que el texto que empieza con `[claude-monitor · Telegram] El
  usuario respondió:` es suyo. Sin esto el agente lo trata como inyección (§2).
  El texto viene sólo de un chat vinculado y un usuario verificado.
- **Imágenes:** se borran a los 7 días.
- **Privacidad:** el detalle de cada permiso y el último mensaje de cada turno
  pasan por los servidores de Telegram. La pantalla de configuración lo avisa
  antes de activar.

## 9. Configuración (sección "Telegram" de la app)

Pensada para que cada compañero la arme solo:

1. Guía de tres pasos: crear el bot con @BotFather; crear un grupo con Temas
   activados y agregar el bot como administrador con "Gestionar temas"; pegar
   el token.
2. Campo para el token, con **Probar** (`getMe` muestra el nombre del bot).
3. **Vincular:** muestra el código y espera el `/vincular` (§8).
4. Minutos de inactividad para el modo fuera.
5. Interruptor **Activo**: instala o saca el hook (§4.3) y arranca o frena el
   long polling.
6. Indicador del modo fuera (y el motivo: manual, tapa o inactividad) con su
   interruptor manual.

Viene apagado. Sin token o sin vincular no se puede activar.

## 10. Errores y degradación

| Situación | Comportamiento |
|---|---|
| App cerrada o colgada | El hook no llega al endpoint y sale con `{}`: la sesión sigue como si el puente no existiera |
| Sin internet | Los envíos se reintentan con espera creciente. La espera del hook sigue hasta que vuelva la conexión o el usuario |
| Telegram rechaza el token (401) | Se desactiva el puente, se sueltan las esperas y la app avisa en la configuración |
| Mensaje a una sesión cerrada | El bot contesta "esa sesión terminó" |
| Tema borrado | Se crea uno nuevo en el próximo mensaje |
| La toma falla (el proceso no cierra, `-p` sale con error) | Se avisa en el tema con el error y la sesión no se toca más |
| Dos respuestas a la misma solicitud | Vale la primera; la segunda recibe "ya no está vigente" |

## 11. Plan de pruebas

Unitarias con vitest, como el resto del repo:

- `puente`: cada evento produce su mensaje y cada respuesta produce el JSON
  exacto del hook (los formatos de §2); se ignoran los mensajes de otro chat o
  de otro usuario; al volver se sueltan las esperas; los botones vencidos no
  hacen nada.
- `presencia`: los pasos de §7, con el tiempo simulado.
- `telegram`: `fetch` simulado; recorte a 4096 caracteres; el long polling
  avanza el `offset`.
- Vinculación: el código vence, es de un solo uso y fija `chat_id` y `from.id`.
- `tomar`: sólo toma sesiones quietas; arma el comando correcto (cuenta, `cwd`,
  `--chrome`) y no corre dos turnos a la vez.
- `remoto-hook.js` contra un endpoint falso: sale con `{}` si no hay endpoint,
  y escribe tal cual lo que el endpoint devuelve.

Antes de implementar: la prueba de la tapa (§7.2).
Antes de entregar: una prueba de punta a punta con un bot real en la PC del
usuario (permiso, pregunta, instrucción, imagen, toma de una sesión quieta y
vuelta a la PC).

## 12. Reparto

- Sale en la 0.23, apagado por defecto.
- El README suma la sección "Telegram" con los pasos de §9.
- No toca a quien no lo active: sin el interruptor, no se instala ningún hook.

## 13. Archivos afectados

| Archivo | Cambio |
|---|---|
| `electron/telegram.ts` | nuevo |
| `electron/puente.ts` | nuevo |
| `electron/presencia.ts` | nuevo, más el ayudante de la tapa en PowerShell |
| `electron/tomar.ts` | nuevo |
| `electron/hooks/remoto-hook.js` | nuevo, se copia a `%APPDATA%` al activar |
| `electron/main.ts` | IPC de la configuración; arranque y cierre del puente con la app |
| `electron/preload.ts`, `shared/types.ts` | la API de la configuración |
| `src/…` | la sección "Telegram" y el aviso "Continuadas desde Telegram" |
| `electron/plugins.ts` | sin cambios: el hook viaja con `syncAllPlugins` |
| `package.json` | `extraResources` para el hook y el ayudante; versión 0.23.0 |
