# Claude Monitor sobre WSL — diseño

Fecha: 2026-09-07
Estado: aprobado (2026-09-07). Pendiente: plan de implementación.
Alcance: que el monitor (Windows) liste y opere las sesiones de un Claude Code
instalado en una distro de WSL en la MISMA máquina.

---

## 1. Problema

El equipo trabaja de tres formas a la vez, y las tres tienen que funcionar:

| Modo | Estado |
|---|---|
| Claude Code CLI en **Windows** | ✅ ya funciona — es el caso original del monitor |
| Claude **Desktop**, eligiendo la carpeta del proyecto | ✅ ya funciona |
| Claude Code CLI desde **Ubuntu (WSL)** | ❌ lo que agrega este diseño |

Los dos primeros no se tocan. La única parte de este diseño que alcanza a una
persona que sólo usa Windows es el guard de §8.1, y es estrictamente
protectora: hoy `deleteProfile` haría `rm -rf` de cualquier `configDir`, y pasa
a poder borrar sólo los que la app misma creó bajo `profilesRoot()`
(`profiles.ts:168`). El `~/.claude` real queda protegido dos veces.

El monitor sólo ve los dos primeros. `grep -rni "wsl"` sobre `electron/ src/ shared/
build/` da **cero** coincidencias: no es un bug, es una capacidad que nunca se
escribió. Hoy se rompe en cuatro puntos:

| Qué falla | Dónde |
|---|---|
| No aparecen las sesiones de WSL | `profiles.ts:26` — `configDir = homedir()/.claude`, un solo filesystem |
| Reanudar tira "la carpeta ya no existe" | `main.ts:315` → `terminal.ts:117` hace `stat(cwd)` y el `cwd` de WSL es POSIX |
| Crear una sesión nace del lado equivocado | `main.ts:328` lanza `wt.exe` y corre el `claude` de Windows |
| `CLAUDE_CONFIG_DIR` no significa nada en Linux | `terminal.ts:56` escribe una ruta Windows |

### Alcance explícitamente excluido

- **Linux en otra máquina.** Requeriría un componente por red del lado Linux.
  Es otro proyecto.
- **Un monitor que vea al equipo entero.** Agregación multi-máquina, también
  otro proyecto.
- **Claude Desktop para cuentas WSL.** Imposible por construcción, ver §7.

---

## 2. Lo que se midió

Todo esto se verificó en la máquina de desarrollo (Windows 11 + WSL2 Ubuntu),
no se supuso. Las decisiones de abajo dependen de estos números.

| Prueba | Resultado |
|---|---|
| `node:fs` de Electron sobre `\\wsl.localhost\Ubuntu\...` | readdir, write y delete **OK** |
| `wsl.exe -d Ubuntu --cd /posix -- bash -lc` | OK |
| `WSLENV` inyecta `CLAUDE_CONFIG_DIR` en la distro | OK |
| `wslpath -w` traduce POSIX → UNC | OK |
| Junction de Windows dentro de ext4 | **falla** — "Función incorrecta" |
| Symlink de Linux a `/mnt/c`, leído desde Windows por UNC | **falla** — 1 entrada de 31 |
| Symlink de Linux a `/mnt/c`, leído/escrito desde WSL | OK (31 visibles, escritura OK) |
| Leer 12 transcripts reales (16,8 MB) por UNC | 0,94 s |
| Los mismos en NTFS local | 0,06 s → **penalización 16x** |
| Tocar la UNC de una distro **apagada** | devuelve True en 1,90 s y **la enciende** |
| `wsl -l --running` | 0,12 s y **no** enciende nada |
| `wsl -l -q` | sale en **UTF-16LE** (`55 00 62 00 75 00 …`), no UTF-8 |
| `vmmemWSL` con la distro arriba | 345 MB |

### Consecuencia mayor: el pozo no se puede extender a WSL

`shared-projects.ts` hace que todas las cuentas compartan `projects/` mediante
un junction de Windows, y `sessions:list`, `:transcript`, `:tokens` y `:resume`
leen todos de esa raíz única desde el lado Windows.

Las dos direcciones de enlace fallan, cada una en un sentido: no se puede crear
un junction de Windows dentro de ext4, y un symlink de Linux hacia `/mnt/c` lo
lee WSL pero **no** lo lee Windows por la UNC. Por lo tanto **ninguna variante
de "meter WSL al pozo con un enlace" funciona**, y el diseño tiene que asumir
múltiples raíces.

---

## 3. Decisión de producto

Las sesiones de WSL y las de Windows **se ven juntas, cada una en su mundo**:
una sola lista ordenada por fecha, con marca de origen; una sesión de WSL se
reanuda en WSL, una de Windows en Windows o Desktop. No se intercambian.

Se descartó "una sola pileta intercambiable" porque exigiría que el CLI de WSL
escribiera dentro del pozo NTFS por symlink — el patrón que `desktop.ts:38`
documenta como ya fallado (`PlantDetectedError`: Claude Code lee a través de un
`projects` enlazado y se niega a escribir).

**Entrega en dos rebanadas:** primero lectura, después el lanzador.

---

## 4. Modelo de datos

```ts
/** Dónde vive una instalación de Claude Code. Ausente = Windows: es el caso de
 *  siempre, y un profiles.json escrito antes de esto sigue siendo válido. */
export type Entorno =
  | { tipo: 'windows' }
  | { tipo: 'wsl'; distro: string; home: string };  // home POSIX: /home/vos

export type Profile = {
  id: string;
  name: string;
  configDir: string;   // WSL: \\wsl.localhost\Ubuntu\home\vos\.claude
  isDefault: boolean;
  entorno?: Entorno;
};

export type SessionMeta = ParsedSession & {
  id: string; projectSlug: string; mtime: number; sizeBytes: number;
  /** La raíz que contiene este archivo. */
  raiz: string;
  /** Dónde se reanuda. La UI la usa para la marca; el lanzador, para el shell. */
  entorno: Entorno;
};
```

**`configDir` se guarda en forma UNC, no POSIX.** Es lo que más código ahorra:
`credentials.ts`, `usage.ts`, `onboarding.ts` y `sessions.ts` ya reciben un
`configDir` y lo leen con `node:fs`, y la lectura por UNC está verificada. Con
la UNC esos cuatro módulos **no se tocan**. La forma POSIX se deriva
(`home + '/.claude'`) y sólo la necesita el lanzador.

**`SessionMeta` lleva la raíz, no un `profileId`.** Por el pozo, muchas cuentas
Windows comparten una raíz: atar la sesión a una cuenta sería falso.

**`entorno` es opcional a propósito:** su ausencia significa Windows, así que
los `profiles.json` existentes siguen siendo válidos sin migración.

### Fronteras: qué NO cambia

- El pozo sigue igual para cuentas Windows. `shareProjects` gana un guard:
  **nunca** para cuentas WSL (hoy intentaría el junction y dejaría basura).
- `getSharedRoot()` conserva su significado exacto: el pozo Windows. Se agrega
  `raices()`, que devuelve `[pozo, ...raícesWSL]`.
- `credentials.ts`, `usage.ts`, `onboarding.ts`: sin cambios.

### Invariante que se debilita

`shared-projects.ts:5` promete hoy *"Hace que todas las cuentas vean las mismas
conversaciones."* Pasa a ser **"todas las cuentas de Windows"**. Es consecuencia
directa de §2 y de §3, y el comentario debe reescribirse: una promesa que el
código hace por escrito no puede quedar desactualizada.

---

## 5. Rebanada 1 — lectura

### 5.1 Alta explícita, detección asistida

No hay autodetección silenciosa. El panel ofrece "Agregar cuenta de WSL", corre
la detección y muestra lo encontrado para que el usuario elija. Razones:
coherente con `createProfile`, evita cuentas que aparecen solas, y evita el
efecto secundario de arrancar distros a espaldas del usuario.

Módulo nuevo `electron/wsl.ts`, con el trabajo sucio aislado en funciones puras:

```ts
/** `wsl -l -q` sale en UTF-16LE. Medido: 55 00 62 00 75 00 … */
export function parseDistros(stdout: string): string[];
/** \\wsl.localhost\<distro>\<home>\.claude a partir del $HOME POSIX. */
export function configDirUNC(distro: string, home: string): string;
```

Al dar de alta se pregunta una vez `bash -lc 'echo $HOME'` y se persiste en
`Entorno.home`, para que ningún arranque posterior tenga que encender la distro
sólo para averiguar una ruta. También se chequea `bash -lc 'command -v claude'`:
si falta, el alta falla con "en Ubuntu no hay `claude` instalado" en vez de
crear una cuenta rota.

### 5.2 De una raíz a N

`sessions:list` pasa de `listSessions(await getSharedRoot())` a recorrer
`raices()` y mezclar, ordenando por `mtime` descendente sobre el conjunto
unido. `listSessions` gana un segundo parámetro `entorno` y **etiqueta el objeto
antes de cachearlo**: la caché guarda el `SessionMeta` armado, y una etiqueta
puesta después quedaría fuera de la caché.

`findSession(id)` busca en todas las raíces y la ruta del `.jsonl` sale de
`session.raiz`. Eso desarma la suposición de raíz única de `main.ts:52`.

### 5.3 La penalización de 16x

El diseño actual ya la absorbe casi entera, y por eso **no se construye nada
todavía**:

- `listSessions` no lee archivos completos: `readSessionFile` corta apenas tiene
  `cwd` y `preview` (`sessions.ts:70`). La lista lee cabeceras, no 20 MB.
- Las cachés de `sessions.ts` y `tokens.ts:147` están indexadas por
  `(mtimeMs, size)` por archivo: el 16x se paga **una vez por archivo**, no por
  refresco.
- El consumo ya viaja en un IPC aparte del listado, por diseño.

Lo único expuesto es la **primera** corrida de `tokensFor`, que es secuencial y
lee entero. Se mide con datos reales antes de decidir. **Plan B si duele:**
paralelismo acotado por raíz. No se construye especulativamente.

### 5.4 Nunca sondear la UNC a ciegas

`raices()` pregunta primero con `wsl -l --running` (0,12 s, sin efecto) y
**sólo toca la UNC de una distro que ya está corriendo**.

Esto no es una optimización: tocar la UNC **enciende la distro** (medido), y el
panel refresca la lista periódicamente. Sin esta regla, el monitor dejaría 345
MB de VM encendidos permanentemente — sería la causa del problema de memoria
que se supone que ayuda a observar.

Una distro apagada se muestra como "distro apagada — encender", con un botón
que la enciende porque el usuario lo pidió, nunca de rebote.

### 5.5 Qué funciona al terminar la rebanada 1

| | Estado |
|---|---|
| Sesiones de WSL mezcladas y marcadas | ✅ |
| Transcript | ✅ |
| Consumo | ✅ |
| Borrar sesión de WSL | ⛔ **ver §9, decisión abierta** |
| Reanudar / crear en WSL | ⛔ deshabilitado **con motivo a la vista** ("se reanuda desde Ubuntu"), no un error |
| Botón Desktop en cuentas WSL | ⛔ deshabilitado (permanente, §7) |

---

## 6. Rebanada 2 — el lanzador

### 6.1 `openTerminal` se bifurca

Windows queda intacto (`wt.exe` con fallback a PowerShell). Para WSL:

```
wt.exe --title <cuenta> wsl.exe -d Ubuntu --cd /home/vos/proy -- bash -lc "<comando>"
```

con caída directa a `wsl.exe` sin `wt.exe`, igual que hoy. El `--cd` va **como
argumento**, no por la línea del shell: el `cwd` sale de un `.jsonl` y no es
confiable, así que nunca pasa por un parseo de shell.

`bash -lc` y no `bash -c`: hace falta el perfil de login para que `claude` esté
en el PATH (nvm y similares).

### 6.2 `CLAUDE_CONFIG_DIR` por `export`, no por `WSLENV`

`WSLENV` funciona (medido), pero se descarta: es una variable **global del
proceso** que habría que componer sin pisar lo que el usuario ya tenga, y ese
merge es frágil por una ganancia nula. Va como `export` dentro del `bash -lc`,
con la ruta POSIX (`/home/vos/.claude`, no la UNC).

`sessionEnv` conserva su trabajo actual — borrar todo lo que empiece con
`CLAUDE`, por lo que documenta `terminal.ts:20` — y la variable de la cuenta se
inyecta del lado Linux.

### 6.3 Traducción de rutas

```ts
export function posixAWindows(distro: string, p: string): string;
export function windowsAPosix(distro: string, p: string): string;
```

Puras y testeadas, sin gastar un proceso en `wslpath`. La inversa no es
decorativa: `sessions:new` abre el diálogo de carpeta de Windows, que devuelve
una ruta Windows, y para una cuenta WSL hay que volverla POSIX antes del `--cd`.

`/mnt/c/...` mapea a `C:\...` directo, no a la UNC: es la misma carpeta y por
NTFS es 16x más rápido.

### 6.4 Comillas y banner

Aparece `shQuote` (comilla simple POSIX: `'` → `'\''`), hermano de `psQuote`.
`bannerCommand` necesita su versión bash: hoy escribe `Write-Host`, que dentro
de Ubuntu no es nada.

### 6.5 Login

`profiles:login` hoy hace `spawn('claude', ['auth','login'], { shell: true })`
(`login.ts:79`) — el CLI de Windows. Para una cuenta WSL tiene que correr dentro
de la distro. `requireLogin` y `credentials.ts` **no se tocan**: leen
`.credentials.json` del `configDir`, y la lectura por UNC está verificada.

---

## 7. Claude Desktop y WSL: incompatibles por construcción

Desktop es una app Windows y su pestaña Code corre el binario Windows
(`...\claude-code\<version>\claude.exe`, observado en los procesos vivos). No
puede hospedar una sesión de la distro. El botón queda deshabilitado para
cuentas WSL de forma permanente. Simularlo sería mentir.

---

## 8. Errores y degradación

### 8.1 Riesgo que destruye datos: `deleteProfile`

`profiles.ts:203`:

```ts
await unlinkShared(profile.configDir);
await rm(profile.configDir, { recursive: true, force: true });
```

Para una cuenta WSL, `configDir` es `\\wsl.localhost\Ubuntu\home\vos\.claude`:
**la instalación real de Claude Code de esa persona**. Borrar la cuenta desde el
panel se la lleva puesta, y el borrado por UNC está verificado como funcional.
El guard actual sólo cubre `isDefault` / `id === 'default'`.

**Arreglo — invariante más fuerte que el de hoy:** el `configDir` de una cuenta
WSL es *adoptado*, no creado por la app. `deleteProfile` sólo puede hacer `rm`
de un `configDir` que viva **debajo de `profilesRoot()`**; cualquier otro se da
de baja del registro y no se toca en disco. Protege además el caso que el
comentario actual ya temía, sin depender de un campo de un archivo editable.
`unlinkShared` se saltea: en WSL no hay junctions.

### 8.2 Estados de una raíz, ninguno mudo

| Estado | Mensaje | Acción |
|---|---|---|
| Distro no existe | "La distro Ubuntu ya no está" | quitar la cuenta |
| Distro apagada | "Distro apagada" | encender (explícito) |
| Corriendo, sin `$HOME/.claude` | "No hay Claude Code configurado ahí" | — |
| Corriendo, sin `claude` en PATH | "Falta el CLI en Ubuntu" | — |
| OK | sesiones | — |

Lo prohibido es lo de hoy: `sessions.ts:107` devuelve `[]` cuando `readdir`
falla, lo que con una raíz WSL serían las sesiones desapareciendo sin
explicación.

### 8.3 La carrera es real

Observada en la máquina de desarrollo: la distro se encendió al tocar la UNC y
se apagó sola por inactividad antes del chequeo siguiente. Entre que `raices()`
dice "está corriendo" y la lectura ocurre, la distro puede haberse apagado. La
lectura lo tolera y marca la raíz como "se apagó"; nunca tira.

### 8.4 Timeouts

Ningún `execFile` del proyecto tiene `timeout` (`desktop.ts:11`,
`chrome-launch.ts:9`). Se tolera hoy porque son procesos locales y rápidos; con
WSL deja de serlo (1,90 s sólo para tocar una UNC apagada), y esto corre en el
proceso main: una distro enferma congelaría el panel. **Todo `wsl.exe` y todo
sondeo UNC de esta función llevan timeout.** No se le pone timeout al resto del
proyecto: es otro trabajo y no se mezcla acá.

---

## 9. Decisión tomada: borrado en la rebanada 1

**Borrar sesiones de WSL en la rebanada 1: ⛔.** Confirmado al aprobar el spec.

Es una operación destructiva sobre datos que viven fuera del área de la app, por
una clase de ruta nueva y sin kilómetros en producción. Está contenida (la ruta
se arma dentro de la raíz, el id es el nombre del archivo), así que habilitarla
más adelante es defendible: pasa a ✅ en §5.5 y es un cambio de una línea. El
camino se prueba igual en el banco de §10, para llegar a la rebanada 2 con esa
ruta ya ejercitada.

---

## 10. Plan de pruebas

**Unitario (vitest), sin WSL:** `parseDistros` con los bytes UTF-16LE reales,
`configDirUNC`, `posixAWindows`/`windowsAPosix` ida y vuelta (incluido
`/mnt/c`), `shQuote` con comillas adentro, el argv de `wsl.exe`, el banner bash,
la máquina de estados de §8.2, el guard de borrado de §8.1, y el **test de
no-regresión** de que una cuenta Windows toma exactamente el camino de hoy.

**Integración en la máquina de desarrollo, sin instalar el CLI:** se arma un
`~/.claude` falso en la distro con transcripts reales copiados
(`cp /mnt/c/.../*.jsonl ~/.claude/projects/<slug>/`). Con eso se ejercita de
punta a punta listar, transcript y consumo sobre UNC. El lanzador se verifica
sustituyendo `claude` por `echo`: se comprueba que llegan el `cwd` y el
`CLAUDE_CONFIG_DIR` correctos dentro de la distro.

El camino de **borrado** también se ejercita en este banco, aunque §9 lo deje
apagado en la UI de la rebanada 1: la idea es llegar a la rebanada 2 con esa
ruta ya probada, no descubrirla ahí.

**No verificable en la máquina de desarrollo — aceptación manual:** un reanudar
real y un login real dentro de WSL requieren la distro con el CLI instalado.
Queda registrado como pendiente de aceptación, **no como probado**.

---

## 11. Archivos afectados

| Archivo | Cambio |
|---|---|
| `shared/types.ts` | `Entorno`, `Profile.entorno`, `SessionMeta.raiz`/`.entorno` |
| `electron/wsl.ts` | **nuevo** — detección, rutas, argv, estados |
| `electron/profiles.ts` | `raices()`, alta de cuenta WSL, guard de §8.1 |
| `electron/sessions.ts` | `listSessions(configDir, entorno)`, etiqueta en la caché |
| `electron/shared-projects.ts` | guard: nunca junction en WSL; reescribir el comentario de §4 |
| `electron/terminal.ts` | bifurcación del lanzador, `shQuote`, banner bash |
| `electron/main.ts` | `sessions:list` sobre N raíces, `findSession` por raíz |
| `electron/tokens.ts` | sin cambios en el diseño aprobado; **sólo** si se activa el plan B de §5.3 |
| `electron/desktop.ts` | guard: deshabilitado en cuentas WSL |
| `src/*.tsx` | marca de origen, estados de raíz, botones deshabilitados con motivo |
