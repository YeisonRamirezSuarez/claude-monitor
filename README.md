# Claude Monitor

Gestor de sesiones y cuentas de Claude Code.

## Telegram (seguir a los agentes desde el celular)

Cuando no estás en la PC, la app te manda a Telegram lo que tus agentes necesitan y te deja contestar desde ahí.

Necesita [Node.js](https://nodejs.org) instalado en la PC (el hook que lo conecta con Claude Code corre con `node`).

1. En Telegram, hablale a **@BotFather**, mandá `/newbot` y copiá el token.
2. Creá un grupo, activá **Temas** (Ajustes del grupo → Temas) y agregá tu bot como **administrador** con permiso **Gestionar temas**.
3. En la app: **Telegram** → pegá el token → **Probar y guardar** → **Vincular** → mandá en el grupo el `/vincular 123456` que te muestra.
4. Prendé **Activo**. Las sesiones que abras desde ese momento usan el puente; las que ya estaban abiertas, al reabrirlas.

Cada sesión tiene su tema. Te llegan los pedidos de permiso (✅/❌), las preguntas (con botones) y el fin de cada turno: lo que escribas en el tema es la siguiente instrucción. Una sesión que ya usaste desde Telegram queda escuchando al terminar cada turno, aunque estés en la PC: lo que le escribas desde el celular lo recibe al instante y sigue en su misma consola (la consola muestra "running Stop hooks…"; apretá Esc para escribir ahí). En la PC nunca se cierra la consola de una sesión. Si le escribís mientras trabaja, lo recibe en su próximo paso (en la consola aparece "📩 Telegram: …"); al terminar se borran el progreso y los avisos y queda la respuesta. Cuando tu mensaje le llega al agente, le aparece 👀; mientras trabaja, el tema muestra "escribiendo…" y un mensaje "⏳ Trabajando…" con sus últimos pasos (herramientas y lo que va escribiendo) que se actualiza solo y se borra al terminar. Lo que responde llega con formato (negritas, listas, código). También podés mandar fotos (se borran a los 7 días).

`/estado` muestra cómo va cada sesión; `/fuera` y `/vuelvo` fuerzan el modo. El modo fuera se activa solo al cerrar la tapa (tras un minuto sin tocar teclado ni mouse) o tras los minutos sin actividad que elijas, y se apaga al volver a usar la PC.

Lo que pide permiso y el último mensaje de cada turno pasan por los servidores de Telegram.
