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
  actividad), Reuniones (los que se hablan van a sentarse a la mesa), Baños (ala al lado de
  Trabajo: inodoros con mampara, lavamanos con espejo, ducha, bañera) — y la puerta al pie del
  pasillo. Viene como plano por defecto (`assets/default-layout-4.json`, revisión 4): una
  instalación nueva lo recibe, y un `~/.pixel-agents/layout.json` de una revisión anterior se
  reemplaza solo al conectarse la oficina, conservando sus mascotas; el viejo queda al lado como
  `layout.rev<N>.json`. Los subagentes se sientan en el escritorio libre más cercano a su principal.
- **Vida en la oficina:** en el descanso, la mitad de las veces van a hacer algo (nevera, piano,
  dispensador de agua, cocina, tetera) con las manos ocupadas, y cada 30 s cambian de actividad; el
  televisor de la sala se prende mientras alguien descansa ahí (el de pared, también mientras
  trabajan), y la pantalla de Reuniones mientras hay reunión.
- **Estrés:** claude-monitor manda `estresado` cuando un agente falla 3 herramientas seguidas o lo
  último fue un error de la API; va a los Baños y se agarra la cabeza bajo una nube de tormenta, con
  "😫 Estresado" en su etiqueta, hasta que una herramienta le sale bien. La pose se dibuja sobre el
  cuadro de frente (`stressFrame` en `characters.ts`): las hojas de personajes no la traen.
- **Personalizar** (🎨 en la etiqueta del agente seleccionado; `sprites/looks.ts` y
  `components/CustomizerModal.tsx`): cuerpo (uno de los 6 de base), piel, peinado (original, corto,
  largo, moño, coleta, cresta, afro, calvo) y su color, ropa (original, vestido, buzo con capucha,
  traje) y sus colores, sombrero (gorra, gorro, sombrero, copa), gafas (redondas, cuadradas, de sol),
  barba (bigote, corta, completa) y contextura (normal, alto, bajito, grueso), con vista previa en
  las tres direcciones. El cuerpo y las poses salen de la hoja de base; la cabeza se arma de nuevo
  con máscaras (cráneo, cara, pelo, accesorios) sobre la fila del cuello, que es la misma en las 6
  hojas; los colores se cambian por rol (piel, pelo, arriba, abajo, zapatos) leyendo dónde aparece
  cada color en el cuadro de frente. claude-monitor la guarda (`apariencias.json`) por sesión o por
  cuenta y se la manda a la oficina (`claude-monitor:looks`).
- **Emociones:** al hablar, cada uno muestra a ratos en su globo un corazón, una idea, "!", "?" o una
  risa, con un saltito; el informe final del subagente, siempre alegre.
- **Muebles de Kenney** (`KN_*`, ver `KENNEY-LICENSE.txt`): mesas de reunión, sillas, sillones, cocina,
  piano, lámparas y plantas de "Roguelike Indoors" de Kenney (www.kenney.nl), **CC0 1.0**. Se
  importan con `scripts/claude-monitor-kenney.cjs <roguelikeIndoor_transparent.png>`. Las
  alfombras son la capa de alfombras del propio motor.
- **Sesiones cerradas:** claude-monitor le pide a la oficina que cierre (el agente sale por la puerta)
  las sesiones que ya no están vivas en el registro; Pixel Agents sólo se enteraba por el hook
  `SessionEnd`, que falta en las cuentas sin hooks. Los subagentes que se lanzaron antes de que
  abriera la oficina se adoptan igual (transcript escrito en los últimos 3 min). Esa revisión lee
  todos los subagentes de la sesión, así que se hace cada 30 s por sesión y no en cada tick: en
  cada tick eran ~700 lecturas de disco por segundo con unas pocas sesiones largas abiertas. Los
  `.meta.json` se leen una sola vez (se escriben al lanzar el subagente y no cambian): una sesión
  con un subagente corriendo se revisa en cada tick y releía los ~280 de la sesión por segundo.
- **Opciones de la oficina:** "Watch All Sessions", etiquetas siempre visibles y salas visibles se
  prenden en cada arranque (`cli.ts`; también son el valor por defecto en `configPersistence.ts`).
  Sin "Watch All Sessions" una PC sin los hooks aprobados no veía ninguna sesión, y la 0.19.0 lo
  dejaba guardado apagado.
- **Hooks en todas las cuentas:** al aprobar los hooks (o con "Instant Detection") se instalan en el
  `settings.json` de cada cuenta de `profiles.json` que exista, no sólo en `~/.claude`; las de WSL se
  saltean (su Claude corre adentro de la distro). Una cuenta agregada con la oficina abierta los recibe
  sola (se vigila `profiles.json`).
- **Ciclo de vida:** arranca con la app y se cierra con ella; si la app muere sin cerrarlo, se va
  solo (`PIXEL_AGENTS_PARENT_PID`). Si no, el huérfano seguía y el próximo arranque lo reusaba.
- **Equipamiento:** TV de pared, mueble con TV, pantalla de proyección y proyector (dibujados por el script, Kenney no los tiene) más sillas, sillón, candelabro, lámpara, cuadros, mapa, espejo, estante y cajonera de Kenney; ubicados en el edificio. Categorías nuevas **Cocina** (mesadas con tetera, frascos, botellas, platos y tabla, vitrina de Kenney; microondas, tostadora, cafetera, licuadora, lavadora y dispensador de agua dibujados) y **Baño** (inodoro, lavamanos, ducha, mampara, bañera, toallero dibujados); en Tech, ventilador e impresora, y en Pared, aire acondicionado y cuadritos.
- **Borrador:** saca primero los muebles de la baldosa (lo que está encima antes que el escritorio) y recién después el piso; una acción por baldosa en cada clic.
- **Mascotas:** colores por mascota (gato: negro, naranja, gris, blanco, chocolate, crema; perro: canela, marrón, blanco, negro) y varias por especie: el carrusel agrega, la lista con × saca. `petType` sigue siendo el índice por nombre de carpeta: una especie nueva tiene que ordenar después de las existentes. Especies nuevas, dibujadas por `scripts/claude-monitor-pets.cjs` en carpetas `km-*` (ordenan detrás de claudio y gitcat): conejo, pato, cerdito y tortuga.
- **Nombres:** las etiquetas usan los nombres de `%APPDATA%\claude-monitor\nombres.json`, y si no hay,
  el nombre de la sesión del registro de Claude Code (no la carpeta).
- **Build:** el CLI va con fastify adentro (sin `external` en esbuild): el portable de Electron
  descomprime en Temp y perdía archivos sueltos de un `node_modules`.

`electron/pixel-agents.ts` lo arranca con el Node de Electron.

Para actualizarlo: clonar upstream, aplicar el parche, `npm install && npm run asyncapi:generate &&
node esbuild.js --production && npm run build:webview`, correr `cd webview-ui && npx vitest run`,
y copiar `dist/` (sin `.map`, `extension.js` ni `uninstall.js`) acá.
