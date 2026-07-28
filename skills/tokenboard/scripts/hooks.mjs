import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAntigravitySettingsValid, getAntigravityHookStatus, installAntigravityHook, uninstallAntigravityHook } from './antigravity-hook.mjs'
import { assertClaudeSettingsValid, getClaudeHookStatus, installClaudeHook, uninstallClaudeHook } from './claude-hook.mjs'
import { configDir, parseArgs } from './config.mjs'
import { assertCodexNotifyWritable, getCodexHookStatus, installCodexHook, uninstallCodexHook } from './codex-hook.mjs'
import { errorMessage } from './error-message.mjs'
import { antigravitySource, claudeSource, codexSource, isTokenBoardNotifyHandler, nodeFs, notifyHandlerMarker, readOptional, readSources, readUninstallSources, removeNotifyHandler } from './hooks-utils.mjs'

export function hookPaths({ homeDir = homedir(), stateDir = configDir(), env = process.env } = {}) {
  const tokenboardHome = stateDir
  const binDir = join(tokenboardHome, 'bin')
  const codexHome = resolveEnvPath(env.CODEX_HOME) || join(homeDir, '.codex')
  const claudeHome = resolveEnvPath(env.CLAUDE_CONFIG_DIR) || resolveEnvPath(env.CLAUDE_HOME) || join(homeDir, '.claude')
  const antigravityHome = resolveEnvPath(env.ANTIGRAVITY_CONFIG_DIR) ||
    resolveEnvPath(env.ANTIGRAVITY_HOME) ||
    join(homeDir, '.gemini', 'antigravity-cli')
  const antigravityIdeHome = resolveEnvPath(env.ANTIGRAVITY_IDE_CONFIG_DIR) ||
    join(homeDir, '.gemini', 'antigravity-ide')
  const antigravityAppHome = resolveEnvPath(env.ANTIGRAVITY_APP_CONFIG_DIR) ||
    join(homeDir, '.gemini', 'antigravity')
  return {
    stateDir: tokenboardHome,
    binDir,
    notifyPath: join(binDir, 'notify.cjs'),
    notifyScriptPath: fileURLToPath(new URL('./notify.mjs', import.meta.url)),
    statuslineScriptPath: fileURLToPath(new URL('./antigravity-statusline.mjs', import.meta.url)),
    codexConfigPath: join(codexHome, 'config.toml'),
    codexOriginalPath: join(tokenboardHome, 'codex_notify_original.json'),
    claudeSettingsPath: join(claudeHome, 'settings.json'),
    antigravitySettingsPath: join(antigravityHome, 'settings.json'),
    antigravityIdePath: antigravityIdeHome,
    antigravityPath: antigravityAppHome,
    antigravityOriginalStatuslinePath: join(tokenboardHome, 'antigravity_statusline_original.json')
  }
}

export function installHooks(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const paths = options.paths || hookPaths(options)
  const fs = options.fs || nodeFs()
  const nodePath = options.nodePath || process.execPath
  const platform = options.platform || process.platform
  const sources = readSources(flags.source || flags.sources || 'all')
  validateHookTargets({ sources, paths, fs })

  if (needsNotifyHandler(sources)) {
    fs.mkdir(paths.binDir, { recursive: true, mode: 0o700 })
    fs.writeFile(paths.notifyPath, buildNotifyHandler({
      stateDir: paths.stateDir,
      notifyScriptPath: paths.notifyScriptPath,
      nodePath
    }), { mode: 0o700 })
  }

  const results = []
  if (sources.includes(codexSource)) {
    results.push(installCodexHook({ paths, fs, nodePath, platform }))
  }
  if (sources.includes(claudeSource)) {
    results.push(installClaudeHook({ paths, fs, nodePath, platform }))
  }
  if (sources.includes(antigravitySource)) {
    results.push(installAntigravityHook({ paths, fs, nodePath, platform }))
  }
  const installedHooks = {
    codex: getCodexHookStatus({ paths, fs }),
    claudeCode: getClaudeHookStatus({ paths, fs, nodePath, platform }),
    antigravityCli: getAntigravityHookStatus({ paths, fs })
  }
  if (canRemoveNotifyHandler(installedHooks)) {
    removeNotifyHandler({ paths, fs })
  }
  return { notifyPath: paths.notifyPath, hooks: results }
}

export function uninstallHooks(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const paths = options.paths || hookPaths(options)
  const fs = options.fs || nodeFs()
  const nodePath = options.nodePath || process.execPath
  const platform = options.platform || process.platform
  const sourceValue = flags.source || flags.sources || 'all'
  const sources = readUninstallSources(sourceValue)
  const explicitAntigravity = sourceWasExplicitlyRequested(sourceValue, antigravitySource)
  validateUninstallHookTargets({ sources, explicitAntigravity, paths, fs })
  const results = []

  if (sources.includes(codexSource)) {
    results.push(uninstallCodexHook({ paths, fs }))
  }
  if (sources.includes(claudeSource)) {
    results.push(uninstallClaudeHook({ paths, fs, nodePath, platform }))
  }
  if (sources.includes(antigravitySource)) {
    try {
      if (!explicitAntigravity) {
        assertAntigravitySettingsValid({ paths, fs })
      }
    } catch (error) {
      results.push({
        source: antigravitySource,
        action: 'skip',
        changed: false,
        incomplete: true,
        detail: `Antigravity statusline not checked: ${errorMessage(error)}`
      })
      return finishUninstallHooks({ results, paths, fs, nodePath, platform })
    }
    try {
      results.push(uninstallAntigravityHook({ paths, fs }))
    } catch (error) {
      finishUninstallHooksBeforeRethrow({ results, paths, fs, nodePath, platform }, error)
      throw error
    }
  }

  return finishUninstallHooks({ results, paths, fs, nodePath, platform })
}

function finishUninstallHooks({ results, paths, fs, nodePath, platform }) {
  const remainingHooks = {
    codex: getCodexHookStatus({ paths, fs }),
    claudeCode: getClaudeHookStatus({ paths, fs, nodePath, platform }),
    antigravityCli: getAntigravityHookStatus({ paths, fs })
  }
  const notifyRemoved = canRemoveNotifyHandler(remainingHooks)
    ? removeNotifyHandler({ paths, fs })
    : false
  return { notifyPath: paths.notifyPath, notifyRemoved, hooks: results }
}

function finishUninstallHooksBeforeRethrow(args, originalError) {
  try {
    finishUninstallHooks(args)
  } catch (cleanupError) {
    attachCleanupError(originalError, cleanupError)
  }
}

function attachCleanupError(originalError, cleanupError) {
  if (originalError && typeof originalError === 'object') {
    originalError.cleanupError = cleanupError
  }
}

export function hookStatus(options = {}) {
  const paths = options.paths || hookPaths(options)
  const fs = options.fs || nodeFs()
  const nodePath = options.nodePath || process.execPath
  const platform = options.platform || process.platform
  return {
    notifyPath: paths.notifyPath,
    notifyHandler: isTokenBoardNotifyHandler(readOptional(paths.notifyPath, fs)) ? 'installed' : 'not-installed',
    codex: getCodexHookStatus({ paths, fs }),
    claudeCode: getClaudeHookStatus({ paths, fs, nodePath, platform }),
    antigravityCli: getAntigravityHookStatus({ paths, fs }),
    antigravityIde: getAntigravityGuiStatus(paths.antigravityIdePath, fs),
    antigravity: getAntigravityGuiStatus(paths.antigravityPath, fs)
  }
}

export function buildNotifyHandler({ stateDir, notifyScriptPath, nodePath }) {
  return [
    notifyHandlerHeader({ stateDir, notifyScriptPath }),
    notifyHandlerArgParser(),
    notifyHandlerMainFlow(),
    notifyHandlerOriginalForwarder(),
    notifyHandlerHelpers()
  ].join('\n')
}

function notifyHandlerHeader({ stateDir, notifyScriptPath }) {
  return `#!/usr/bin/env node
// ${notifyHandlerMarker} - Auto-generated by TokenBoard. Do not edit.
"use strict";

const { appendFileSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const { join, resolve, win32: windowsPath } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { homedir } = require("node:os");

const STATE_DIR = ${JSON.stringify(stateDir)};
const SIGNAL_DIR = join(STATE_DIR, "notify.signal.d");
const DISPATCH_LOCK_PATH = join(STATE_DIR, "notify.dispatch.lock");
const DISPATCH_WORKER_PATH = join(STATE_DIR, "notify.dispatch.worker");
const DISPATCH_LOCK_STARTUP_GRACE_MS = 5000;
const TASKLIST_TIMEOUT_MS = 2000;
const SYSTEM_ROOT = windowsPath.isAbsolute(process.env.SystemRoot || "")
  ? process.env.SystemRoot
  : "C:\\\\Windows";
const TASKLIST_COMMAND = windowsPath.join(
  SYSTEM_ROOT,
  "System32",
  "tasklist.exe"
);
const NODE_PATH = process.execPath;
const NOTIFY_SCRIPT = ${JSON.stringify(notifyScriptPath)};
const SELF_PATH = resolve(__filename);
const HOME_DIR = homedir();
`
}

function notifyHandlerArgParser() {
  return `
const rawArgs = process.argv.slice(2);
let source = "";
const payloadArgs = [];
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (!source && arg === "--source") {
    source = rawArgs[index + 1] || source;
    index += 1;
    continue;
  }
  if (!source && arg.startsWith("--source=")) {
    source = arg.slice("--source=".length) || source;
    continue;
  }
  payloadArgs.push(arg);
}

if (source !== "codex" && source !== "claude-code") {
  recordHandlerError("source", new Error("Unsupported TokenBoard hook source"));
  process.exit(0);
}
`
}

function notifyHandlerMainFlow() {
  return `
try {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const signalPayload = JSON.stringify({
    source,
    requestedAt: new Date().toISOString(),
  }) + "\\n";
  let queueError;
  try {
    writeQueuedSignal(signalPayload, source);
  } catch (error) {
    queueError = error;
  }
  if (queueError) {
    appendFileSync(join(STATE_DIR, "notify.signal"), signalPayload, "utf8");
    throw queueError;
  }
} catch (error) {
  recordHandlerError("enqueue", error);
}

const dispatchToken = hasLiveTrailingWorker() ? "" : acquireDispatchLock();
if (dispatchToken) {
  try {
    const child = spawn(NODE_PATH, [NOTIFY_SCRIPT, "--source", source], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: STATE_DIR,
        TOKENBOARD_STATE_DIR: STATE_DIR,
        TOKENBOARD_NOTIFY_DISPATCH_LOCK_PATH: DISPATCH_LOCK_PATH,
        TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN: dispatchToken,
        TOKENBOARD_NOTIFY_DISPATCH_WORKER_PATH: dispatchWorkerPath(dispatchToken),
      },
    });
    if (typeof child.pid === "number") {
      setDispatchWorkerPid(dispatchToken, child.pid);
      child.unref();
    } else {
      releaseDispatchLock(dispatchToken);
    }
  } catch (error) {
    releaseDispatchLock(dispatchToken);
    recordHandlerError("background", error);
  }
}
`
}

function notifyHandlerOriginalForwarder() {
  return `
if (source === "codex") {
  try {
    const original = JSON.parse(readFileSync(join(STATE_DIR, "codex_notify_original.json"), "utf8"));
    const cmd = Array.isArray(original && original.notify) ? original.notify : null;
    if (cmd && cmd.length > 0 && !isSelfNotify(cmd)) {
      const child = spawn(cmd[0], [...cmd.slice(1), ...payloadArgs], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env },
      });
      child.unref();
    }
  } catch (error) {
    if (!isMissingFileError(error)) recordHandlerError("original", error);
  }
}

process.exit(0);
`
}

function notifyHandlerHelpers() {
  return `
function acquireDispatchLock() {
  const token = process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  try {
    writeFileSync(DISPATCH_LOCK_PATH, JSON.stringify({
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if (!error || error.code !== "EEXIST") {
      recordHandlerError("dispatch-lock", error);
      return "";
    }
    if (isDispatchLockOwnerAlive(readDispatchFile(DISPATCH_LOCK_PATH))) return "";
    if (!removeStaleDispatchLock()) return "";
    try {
      writeFileSync(DISPATCH_LOCK_PATH, JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return token;
    } catch (retryError) {
      if (retryError && retryError.code !== "EEXIST") recordHandlerError("dispatch-lock", retryError);
      return "";
    }
  }
}

function hasLiveTrailingWorker() {
  try {
    const trailing = JSON.parse(readFileSync(join(STATE_DIR, "trailing.lock"), "utf8"));
    const pid = Number(trailing && trailing.pid);
    return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid);
  } catch (_) {
    return false;
  }
}

function setDispatchWorkerPid(token, pid) {
  try {
    const current = JSON.parse(readFileSync(DISPATCH_LOCK_PATH, "utf8"));
    if (!current || current.token !== token) return;
    writeFileSync(dispatchWorkerPath(token), JSON.stringify({
      token,
      pid,
      startedAt: new Date().toISOString(),
    }), {
      encoding: "utf8",
      mode: 0o600,
    });
    const verified = JSON.parse(readFileSync(DISPATCH_LOCK_PATH, "utf8"));
    if (!verified || verified.token !== token) removeDispatchWorker(token);
  } catch (error) {
    if (isMissingFileError(error)) {
      removeDispatchWorker(token);
      return;
    }
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
  }
}

function releaseDispatchLock(token) {
  if (!token) return;
  try {
    releaseOwnedDispatchFile(DISPATCH_LOCK_PATH, token);
    releaseOwnedDispatchFile(DISPATCH_WORKER_PATH, token);
  } catch (error) {
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
  }
}

function removeStaleDispatchLock() {
  const quarantinePath = dispatchQuarantinePath(DISPATCH_LOCK_PATH);
  try {
    renameSync(DISPATCH_LOCK_PATH, quarantinePath);
  } catch (error) {
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
    return false;
  }
  let current;
  try {
    current = readDispatchFile(quarantinePath);
  } catch (error) {
    try {
      restoreDispatchFile(DISPATCH_LOCK_PATH, quarantinePath);
    } catch (restoreError) {
      recordHandlerError("dispatch-lock", restoreError);
    }
    recordHandlerError("dispatch-lock", error);
    return false;
  }
  if (isDispatchLockOwnerAlive(current)) {
    restoreDispatchFile(DISPATCH_LOCK_PATH, quarantinePath);
    return false;
  }
  try {
    unlinkSync(quarantinePath);
    removeDispatchWorker(current && current.token);
    return true;
  } catch (error) {
    restoreDispatchFile(DISPATCH_LOCK_PATH, quarantinePath);
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
    return false;
  }
}

function releaseOwnedDispatchFile(path, token) {
  const quarantinePath = dispatchQuarantinePath(path);
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  let current;
  try {
    current = readDispatchFile(quarantinePath);
  } catch (error) {
    restoreDispatchFile(path, quarantinePath);
    throw error;
  }
  if (!current || current.token !== token) {
    restoreDispatchFile(path, quarantinePath);
    return false;
  }
  try {
    unlinkSync(quarantinePath);
    return true;
  } catch (error) {
    restoreDispatchFile(path, quarantinePath);
    throw error;
  }
}

function restoreDispatchFile(path, quarantinePath) {
  try {
    linkSync(quarantinePath, path);
  } catch (error) {
    if (!error || (error.code !== "EEXIST" && error.code !== "ENOENT")) throw error;
  }
  try {
    unlinkSync(quarantinePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function dispatchQuarantinePath(path) {
  return path + ".release-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function isDispatchLockOwnerAlive(current) {
  if (!current) return false;
  const worker = readDispatchWorker(current.token);
  if (worker && worker.token === current.token) {
    const workerPid = Number(worker.pid);
    if (Number.isSafeInteger(workerPid) && workerPid > 0) return isProcessAlive(workerPid);
  }
  if (isDispatchLockStarting(current)) return true;
  const pid = current && Number(current.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  return isProcessAlive(pid);
}

function readDispatchFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readDispatchWorker(token) {
  const tokenWorker = readDispatchFile(dispatchWorkerPath(token));
  if (tokenWorker && tokenWorker.token === token) return tokenWorker;
  const legacyWorker = readDispatchFile(DISPATCH_WORKER_PATH);
  return legacyWorker && legacyWorker.token === token ? legacyWorker : null;
}

function removeDispatchWorker(token) {
  if (!token) return;
  try {
    releaseOwnedDispatchFile(dispatchWorkerPath(token), token);
    releaseOwnedDispatchFile(DISPATCH_WORKER_PATH, token);
  } catch (error) {
    if (!isMissingFileError(error)) recordHandlerError("dispatch-lock", error);
  }
}

function dispatchWorkerPath(token) {
  return DISPATCH_WORKER_PATH + "." + token;
}

function isDispatchLockStarting(current) {
  const startedAt = Date.parse(current && current.startedAt);
  const elapsedMs = Date.now() - startedAt;
  return Number.isFinite(startedAt) && elapsedMs >= 0 && elapsedMs < DISPATCH_LOCK_STARTUP_GRACE_MS;
}

function isProcessAlive(pid) {
  if (pid === process.pid) return true;
  if (process.platform === "win32") {
    const result = spawnSync(TASKLIST_COMMAND, ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: TASKLIST_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return true;
    return String(result.stdout || "").includes('"' + pid + '"');
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

function isSelfNotify(cmd) {
  return cmd.some((part) => {
    if (typeof part !== "string") return false;
    if (!part.includes("notify.cjs")) return false;
    if (part.includes(SELF_PATH)) return true;
    const homePath = SELF_PATH.startsWith(HOME_DIR) ? "~" + SELF_PATH.slice(HOME_DIR.length) : "";
    if (homePath && part.includes(homePath)) return true;
    const resolved = part.startsWith("~/") ? join(HOME_DIR, part.slice(2)) : resolve(part);
    return resolved === SELF_PATH;
  });
}

function recordHandlerError(stage, error) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const message = errorMessage(error);
    appendFileSync(join(STATE_DIR, "notify-handler-errors.log"), JSON.stringify({
      stage,
      message,
      at: new Date().toISOString(),
    }) + "\\n", "utf8");
  } catch (_) {}
}

function errorMessage(error) {
  let isError = false;
  try {
    isError = error instanceof Error;
  } catch (_) {}
  if (!isError) return safeErrorString(error);

  const message = safeErrorPropertyString(error, "message");
  if (message.trim()) return message;
  const name = safeErrorPropertyString(error, "name");
  if (name.trim()) return name;
  return "Unknown error";
}

function safeErrorPropertyString(error, property) {
  try {
    return String(error[property] ?? "");
  } catch (_) {
    return "";
  }
}

function safeErrorString(value) {
  try {
    const message = String(value);
    return message.trim() ? message : "Unknown error";
  } catch (_) {
    return "Unknown error";
  }
}

function isMissingFileError(error) {
  return error && error.code === "ENOENT";
}

function writeQueuedSignal(payload, source) {
  mkdirSync(SIGNAL_DIR, { recursive: true, mode: 0o700 });
  const name = Date.now() + "-" + process.pid + "-" + Math.random().toString(36).slice(2);
  const tempPath = join(SIGNAL_DIR, "." + name + ".tmp");
  const finalPath = join(SIGNAL_DIR, source + ".json");
  writeFileSync(tempPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    renameSync(tempPath, finalPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch (_) {}
    throw error;
  }
}
`
}

function validateHookTargets({ sources, paths, fs }) {
  if (sources.includes(codexSource)) {
    assertCodexNotifyWritable({ paths, fs })
  }
  if (sources.includes(claudeSource)) {
    assertClaudeSettingsValid({ paths, fs })
  }
  if (sources.includes(antigravitySource)) {
    assertAntigravitySettingsValid({ paths, fs })
  }
}

function validateUninstallHookTargets({ sources, explicitAntigravity, paths, fs }) {
  if (sources.includes(codexSource)) {
    assertCodexNotifyWritable({ paths, fs })
  }
  if (sources.includes(claudeSource)) {
    assertClaudeSettingsValid({ paths, fs })
  }
  if (sources.includes(antigravitySource) && explicitAntigravity) {
    assertAntigravitySettingsValid({ paths, fs })
  }
}

function sourceWasExplicitlyRequested(value, source) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .includes(source)
}

function canRemoveNotifyHandler(status) {
  return status.codex === 'not-installed' && status.claudeCode === 'not-installed'
}

function needsNotifyHandler(sources) {
  return sources.includes(codexSource) || sources.includes(claudeSource)
}

function getAntigravityGuiStatus(path, fs) {
  if (!path) return 'not-installed'
  try {
    return pathExists(path, fs) ? 'installed-local-history' : 'not-installed'
  } catch {
    return 'error'
  }
}

function pathExists(path, fs) {
  if (typeof fs.exists === 'function') return fs.exists(path)
  return readOptional(path, fs) !== null
}

function resolveEnvPath(value) {
  return typeof value === 'string' && value.trim() ? resolve(value) : null
}

function runCli(command) {
  try {
    const result = command()
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

export function runInstallHooksCli() {
  runCli(() => installHooks())
}

export function runUninstallHooksCli() {
  runCli(() => uninstallHooks())
}
