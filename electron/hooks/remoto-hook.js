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
