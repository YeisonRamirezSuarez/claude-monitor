#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server/src/providers/hook/claude/hooks/claude-hook.ts
var fs = __toESM(require("fs"));
var http = __toESM(require("http"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));

// core/src/constants.ts
var HOOK_API_PREFIX = "/api/hooks";
var SERVER_JSON_DIR = ".pixel-agents";
var SERVER_JSON_NAME = "server.json";

// server/src/constants.ts
var CONTEXT_SEED_TAIL_BYTES = 256 * 1024;
var SERVERS_DIR = "servers";
var MIN_PORT = 1;
var MAX_PORT = 65535;
var SERVER_REGISTRY_PROTOCOL_VERSION = 1;

// server/src/serverConfig.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isServerTarget(value) {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.port) && value.port >= MIN_PORT && value.port <= MAX_PORT && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === "string" && value.token.length > 0 && (value.debugLog === void 0 || typeof value.debugLog === "string");
}
function isServerConfig(value) {
  if (!isServerTarget(value) || !isRecord(value)) return false;
  return Number.isSafeInteger(value.startedAt) && value.startedAt >= 0 && typeof value.servesSpa === "boolean" && value.protocol === SERVER_REGISTRY_PROTOCOL_VERSION;
}

// server/src/providers/hook/claude/hooks/claude-hook.ts
var SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
var SERVERS_REGISTRY_DIR = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);
var debugLogPath = process.env["PIXEL_AGENTS_DEBUG_LOG"];
function hookDebug(line) {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${(/* @__PURE__ */ new Date()).toISOString()} HOOKSCRIPT ${line}
`);
  } catch {
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function readRegistry() {
  let files;
  try {
    files = fs.readdirSync(SERVERS_REGISTRY_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const live = [];
  for (const file of files) {
    const filePath = path.join(SERVERS_REGISTRY_DIR, file);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!isServerConfig(entry)) {
        hookDebug(`registry-skip reason=malformed file=${file} err=invalid-server-config`);
        continue;
      }
      if (isProcessAlive(entry.pid)) {
        live.push(entry);
      } else {
        hookDebug(`registry-skip reason=dead-pid file=${file} pid=${entry.pid}`);
      }
    } catch (e) {
      hookDebug(
        `registry-skip reason=malformed file=${file} err=${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  return live;
}
function postToServer(server, body, eventName, sid) {
  hookDebug(`POST event=${eventName} sid=${sid} port=${server.port}`);
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: `${HOOK_API_PREFIX}/claude`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`
          },
          timeout: 2e3
        },
        (res) => {
          hookDebug(
            `POST-done event=${eventName} sid=${sid} status=${res.statusCode} port=${server.port}`
          );
          res.resume();
          resolve();
        }
      );
      req.on("error", (err) => {
        hookDebug(
          `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err.message}`
        );
        resolve();
      });
      req.on("timeout", () => {
        hookDebug(`POST-timeout event=${eventName} sid=${sid} port=${server.port}`);
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch (err) {
      hookDebug(
        `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err instanceof Error ? err.message : String(err)}`
      );
      resolve();
    }
  });
}
async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug("exit reason=bad-stdin");
    process.exit(0);
  }
  const eventName = data.hook_event_name ?? "?";
  const sid = data.session_id?.slice(0, 8) ?? "?";
  let servers = readRegistry();
  if (servers.length === 0) {
    try {
      const legacy = JSON.parse(fs.readFileSync(SERVER_JSON, "utf-8"));
      if (!isServerTarget(legacy)) {
        throw new Error("invalid legacy server config");
      }
      servers = [legacy];
    } catch (e) {
      hookDebug(
        `exit reason=no-server-json event=${eventName} sid=${sid} path=${SERVER_JSON} err=${e instanceof Error ? e.message : String(e)}`
      );
      process.exit(0);
    }
  }
  if (!debugLogPath) {
    const withDebugLog = servers.find((s) => s.debugLog);
    if (withDebugLog?.debugLog) debugLogPath = withDebugLog.debugLog;
  }
  const body = JSON.stringify(data);
  await Promise.all(servers.map((server) => postToServer(server, body, eventName, sid)));
}
main().catch(() => {
}).finally(() => process.exit(0));
