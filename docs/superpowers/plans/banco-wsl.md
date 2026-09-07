# Banco de pruebas de WSL

Procedimiento para verificar de punta a punta que claude-monitor lee sesiones que
viven adentro de una distro, **sin necesidad de instalar el CLI de Claude ahí**. El
truco es armar un `~/.claude` falso con transcripts reales copiados desde Windows: la
app no distingue, y así se prueba el camino de lectura por UNC completo.

Este archivo existe para que el banco se pueda repetir. Corresponde a la Task 8 del
plan `2026-09-07-claude-monitor-wsl.md`.

## Estado: PENDIENTE DE EJECUCIÓN

El banco **no se pudo correr** en la máquina donde se desarrolló la rama, porque ahí no
hay `claude` instalado adentro de la distro:

```
$ wsl -d Ubuntu --exec bash -lc 'command -v claude'
  (vacío)
```

Sin el CLI, `createWslProfile` se niega a dar de alta la cuenta —a propósito— y el banco
no puede pasar del paso 1. Hay que correrlo en la otra PC, donde el CLI sí está.

**Nota sobre una medición anterior:** durante el desarrollo se registró que la distro no
arrancaba (`Wsl/Service/CreateInstance/E_UNEXPECTED`). Eso era **transitorio**: más tarde,
en la misma máquina, `wsl -d Ubuntu --exec true` devolvió 0 y la distro levantó normal. La
única razón real por la que el banco no corre es la falta del CLI.

## Lo que sí quedó medido en esta máquina

Estas mediciones no necesitan que la distro arranque, y son las que sostienen el
diseño de la rebanada de lectura:

| Qué | Resultado |
|---|---|
| Codificación de la salida propia de `wsl.exe` (`-l -q`) | UTF-16LE — `Ubuntu` llega como `55 00 62 00 75 00 6e 00 74 00 75 00` |
| Codificación de los mensajes de error de `wsl.exe` | UTF-16LE, y salen por **stdout**, no por stderr |
| `wsl -l -q --running` sin nada corriendo | 0 bytes |
| `wsl -l -q --running` con el servicio roto | 0 bytes y exit `0xC0000142`; el código lo trata como "no hay nada corriendo", que es el resultado seguro: sin distros corriendo no se lee ninguna raíz y no se enciende nada |
| Codificación de la salida de un comando de ADENTRO de la distro | UTF-8 — `echo $HOME` devuelve `/home/wposs` sin NULs. Junto con la fila de arriba, es lo que obliga a decidir la codificación mirando los bytes y no a ciegas |
| `wsl.exe -- <cmd>` contra `wsl.exe --exec <cmd>` | `--` corre el comando a través del shell por defecto de la distro: `-- bash -lc 'X=1; echo "[$X]"'` devuelve `[]`, y un argumento `/home/x; echo INYECTADO` llega re-parseado. `--exec` lo pasa como argv directo: devuelve `[1]` y el argumento hostil llega literal. Todo el proyecto usa `--exec` por esto |
| Costo de `wsl -l --running` | 0,12 s, sin efecto sobre las distros |
| Tocar la UNC de una distro apagada | **La enciende**: 1,90 s, la distro queda `Running` con 345 MB de `vmmemWSL` |
| Lectura por UNC vs NTFS | 16× más lenta (0,94 s vs 0,06 s sobre 12 transcripts / 16,8 MB) |

La penalización de 16× es la razón por la que el paso 3 mide y no supone.

## Paso 1 — Armar un `~/.claude` falso en la distro

```bash
wsl -d Ubuntu --exec bash -lc 'mkdir -p ~/.claude/projects/banco-de-prueba'
wsl -d Ubuntu --exec bash -lc 'cp /mnt/c/Users/$USER/.claude/projects/*/*.jsonl ~/.claude/projects/banco-de-prueba/ 2>/dev/null; ls ~/.claude/projects/banco-de-prueba | wc -l'
```

El segundo comando imprime cuántos transcripts se copiaron. Si imprime `0`, revisar la
ruta de Windows antes de seguir: el resto del banco no prueba nada con una carpeta
vacía. Anotar el número acá:

- Transcripts copiados: `___`
- Tamaño total (`du -sh ~/.claude/projects/banco-de-prueba`): `___`

## Paso 2 — Dar de alta la cuenta y verificar la lectura

Con `npm run dev`:

1. "Agregar cuenta de WSL" → elegir `Ubuntu`.
2. Con la distro **apagada**, la cuenta muestra "Distro apagada" y el botón "Encender".
   Comprobar con `wsl -l -v` que sigue `Stopped` mientras el panel está abierto y
   refrescando: si se enciende sola, la compuerta de la Task 5 está mal.
3. Apretar "Encender". Aparecen las sesiones del banco, con el chip `Ubuntu`.
4. Abrir el transcript de una: tiene que mostrar el contenido real.
5. La columna de consumo se puebla.
6. Las fronteras, que **no** son las mismas para las tres acciones. Con una sesión de
   WSL en la lista:
   - **"Reanudar en terminal" anda.** Abre `wsl.exe` con `--cd` y `--exec` sobre la
     distro de esa sesión, con la cuenta de esa distro y no con la activa. En la
     terminal, `pwd` tiene que dar el `cwd` de la sesión y la conversación tiene que
     retomar donde iba.
   - **"Nueva en terminal…" anda**, con la cuenta activa. Probar los dos destinos del
     diálogo de carpeta:
     - una carpeta de adentro de la distro (por su UNC `\\wsl.localhost\<distro>\…`):
       abre en esa misma ruta POSIX;
     - una carpeta de **Windows** (por ejemplo `C:\proy\x`): tiene que abrir en
       `/mnt/c/proy/x`. Es el caso que más fácil se rompe, porque la traducción vive
       en un solo lugar (`abrirEnWsl`) y el diálogo siempre devuelve ruta de Windows.
   - **"Borrar" sigue deshabilitado**, con el motivo en el tooltip: borrar sesiones de
     WSL no está habilitado en esta rebanada (§9 del spec — decisión de producto, no
     una imposibilidad técnica: por UNC funcionaría).
   - **Todo lo de Desktop sigue deshabilitado**, con el motivo en el tooltip:
     "Reanudar en Desktop" sobre una sesión de WSL, y "Nueva en Desktop…" /
     el "Desktop" del "+" cuando la cuenta activa es de WSL. Es permanente (§7):
     Desktop es una app de Windows y no puede hospedar una sesión de la distro.
   - Los cuatro botones deshabilitados tienen que **verse** deshabilitados (atenuados,
     sin encenderse al pasar el mouse), no sólo comportarse como tales.

## Paso 3 — Medir la primera corrida de `tokensFor`

Cronometrar cuánto tarda la columna de consumo en poblarse:

- Primera vez, caché fría: `___ s`
- Segunda vez, caché caliente: `___ s`

**Criterio de decisión:** si la primera corrida pasa de ~10 s con un volumen realista,
activar el plan B de §5.3 del spec (paralelismo acotado por raíz) **como tarea aparte**.
Si no, dejarlo como está. Construir el paralelismo antes de tener este número sería
adivinar, y el costo de adivinar mal acá es código concurrente que nadie necesitaba.

## Paso 4 — Limpiar

```bash
wsl -d Ubuntu --exec bash -lc 'rm -rf ~/.claude/projects/banco-de-prueba'
```

**Cuidado:** esto borra de forma irreversible una carpeta dentro del `$HOME` real del
usuario en la distro. Antes de correrlo, confirmar con `ls ~/.claude/projects/` que
`banco-de-prueba` es efectivamente la carpeta del banco y no otra cosa. La ruta está
escrita completa a propósito: nunca reemplazarla por un glob.
