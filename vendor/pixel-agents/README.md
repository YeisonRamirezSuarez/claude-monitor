# Pixel Agents (vendorizado)

La Oficina en vivo es [Pixel Agents](https://github.com/pablodelucca/pixel-agents) (MIT, ver
`LICENSE`), compilado desde el commit de `UPSTREAM_COMMIT` con un parche propio
(`claude-monitor.patch`). Todo lo visual de la oficina se hace parchando este motor, no con un
motor aparte.

Qué agrega el parche:

- **Cuentas:** lee las carpetas de todas las cuentas de `profiles.json`, y deduplica las rutas que
  llegan por el junction del `projects/` compartido (`pathKey.ts`), si no una sesión salía dos veces.
- **Comportamiento** (`webview-ui/src/office/engine/claudeMonitor.ts`): el que piensa va a la
  biblioteca; el que espera a un subagente se sienta en un sofá; los que se mandan mensajes caminan
  hasta el otro y conversan; las sesiones y subagentes entran y salen por la puerta (el subagente
  primero saluda a su principal); corona para el principal y subagentes más chicos.
- **Puente con claude-monitor** (`webview-ui/src/claudeMonitorBridge.ts`): filtro por cuenta y
  charlas que claude-monitor detecta en los transcripts; el clic en un personaje se avisa a la
  ventana; `GET /api/claude-monitor/agents` dice qué sesión es cada personaje.
- **Edificio** (`edificio-layout.json`, generado por `scripts/claude-monitor-layout.mjs`): una sola
  oficina con salas — Despacho, Trabajo, Biblioteca (pensar), Descanso (sofás: esperar / sin
  actividad), Reuniones (los que se hablan van a sentarse a la mesa) — y la puerta al pie del
  pasillo. Viene como plano por defecto (`assets/default-layout-2.json`, revisión 2): una
  instalación nueva lo recibe, y un `~/.pixel-agents/layout.json` que sigue en la oficina original
  (revisión 1) se reemplaza solo. Los subagentes se sientan en el escritorio libre más cercano a su
  principal.
- **Muebles de Kenney** (`KN_*`, ver `KENNEY-LICENSE.txt`): mesas de reunión, sillas, sillones, cocina,
  piano, lámparas y plantas de "Roguelike Indoors" de Kenney (www.kenney.nl), **CC0 1.0**. Se
  importan con `scripts/claude-monitor-kenney.cjs <roguelikeIndoor_transparent.png>`. Las
  alfombras son la capa de alfombras del propio motor.
- **Sesiones cerradas:** claude-monitor le pide a la oficina que cierre (el agente sale por la puerta)
  las sesiones que ya no están vivas en el registro; Pixel Agents sólo se enteraba por el hook
  `SessionEnd`, que falta en las cuentas sin hooks. Los subagentes que se lanzaron antes de que
  abriera la oficina se adoptan igual (transcript escrito en los últimos 3 min).
- **Opciones de la oficina:** "Watch All Sessions", etiquetas siempre visibles y salas visibles se
  prenden en cada arranque (`cli.ts`; también son el valor por defecto en `configPersistence.ts`).
  Sin "Watch All Sessions" una PC sin los hooks aprobados no veía ninguna sesión, y la 0.19.0 lo
  dejaba guardado apagado.
- **Ciclo de vida:** arranca con la app y se cierra con ella; si la app muere sin cerrarlo, se va
  solo (`PIXEL_AGENTS_PARENT_PID`). Si no, el huérfano seguía y el próximo arranque lo reusaba.
- **Nombres:** las etiquetas usan los nombres de `%APPDATA%\claude-monitor\nombres.json`, y si no hay,
  el nombre de la sesión del registro de Claude Code (no la carpeta).
- **Build:** el CLI va con fastify adentro (sin `external` en esbuild): el portable de Electron
  descomprime en Temp y perdía archivos sueltos de un `node_modules`.

`electron/pixel-agents.ts` lo arranca con el Node de Electron.

Para actualizarlo: clonar upstream, aplicar el parche, `npm install && npm run asyncapi:generate &&
node esbuild.js --production && npm run build:webview`, correr `cd webview-ui && npx vitest run`,
y copiar `dist/` (sin `.map`, `extension.js` ni `uninstall.js`) acá.
