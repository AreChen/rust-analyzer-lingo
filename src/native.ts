import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const KEY = "nativeProxySettings.v2";
const REAL = "RUST_ANALYZER_LINGO_REAL_SERVER";
const LOCALE = "RUST_ANALYZER_LINGO_LOCALE";
const ENV_KEYS = [REAL, LOCALE];
type ExtraEnv = Record<string, string | number | null>;
export interface SavedValue { present: boolean; value?: unknown }
interface Backup {
  resource?: string;
  target: vscode.ConfigurationTarget;
  original: Record<string, SavedValue>;
  applied: Record<string, SavedValue>;
  customServer?: string;
}
type Backups = Record<string, Backup>;
const keys = ["server.path", "server.extraEnv"];
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => same(x[k], y[k]));
}
export function restoreEnv(current: SavedValue, applied: SavedValue, original: SavedValue): SavedValue {
  if (same(current, applied)) return original;
  if (!current.present || !current.value || typeof current.value !== "object") return current;
  const result = { ...(current.value as ExtraEnv) };
  const installed = (applied.value ?? {}) as ExtraEnv;
  const before = (original.value ?? {}) as ExtraEnv;
  for (const key of ENV_KEYS) {
    if (same(result[key], installed[key])) {
      if (key in before) result[key] = before[key]; else delete result[key];
    }
  }
  return { present: true, value: result };
}
export function isProxy(value: unknown): value is string {
  return typeof value === "string" && /(?:^|[\\/])rust-analyzer-lingo-proxy(?:\.exe)?$/i.test(value);
}
function layer(config: vscode.WorkspaceConfiguration, key: string, target: vscode.ConfigurationTarget): SavedValue {
  const info = config.inspect(key);
  const value = target === vscode.ConfigurationTarget.WorkspaceFolder ? info?.workspaceFolderValue
    : target === vscode.ConfigurationTarget.Workspace ? info?.workspaceValue : info?.globalValue;
  return value === undefined ? {present: false} : {present: true, value};
}
async function put(config: vscode.WorkspaceConfiguration, key: string, value: SavedValue, target: vscode.ConfigurationTarget): Promise<void> {
  await config.update(key, value.present ? value.value : undefined, target);
}
async function exists(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}
function scope(): {resource?: vscode.Uri; target: vscode.ConfigurationTarget; id: string} {
  if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) {
    throw new Error("请先打开一个项目文件夹。中文行内提示无需设置；替换原始诊断只对当前项目启用。");
  }
  const folder = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
  const resource = folder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const config = vscode.workspace.getConfiguration("rust-analyzer", resource);
  const folderOverride = resource && keys.some(key => config.inspect(key)?.workspaceFolderValue !== undefined);
  const target = folderOverride ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
  return {resource, target, id: target === vscode.ConfigurationTarget.WorkspaceFolder ? resource!.toString() : "workspace"};
}
export function expandServer(value: string, folder?: string): string {
  let result = value.replace(/^~[\\/]/, os.homedir() + path.sep)
    .replace(/\$\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
    .replace(/\$\{workspaceFolder\}/g, folder ?? "");
  if (result.includes("${")) throw new Error("服务器路径包含暂不支持的变量，请在 rust-analyzer.server.path 中填写可执行文件路径。");
  if (!path.isAbsolute(result) && /[\\/]/.test(result) && folder) result = path.resolve(folder, result);
  return result;
}
async function resolveServer(custom: string | undefined, resource?: vscode.Uri): Promise<string> {
  if (custom) return expandServer(custom, resource?.fsPath);
  // Follow the official extension's toolchain override before selecting its bundled server.
  const candidates: Array<{file: string; order: string}> = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
      const source = await fs.readFile(path.join(folder.uri.fsPath, name), "utf8").catch(() => "");
      const components = source.replace(/#.*$/gm, "").match(/components\s*=\s*\[([^\]]*)\]/)?.[1];
      if (!components || !/["']rust-analyzer["']/.test(components)) continue;
      try {
        const {stdout} = await exec("rustup", ["which", "rust-analyzer"], {cwd: folder.uri.fsPath, timeout: 10000, windowsHide: true});
        const file = stdout.trim();
        const version = (await exec(file, ["--version"], {timeout: 10000, windowsHide: true})).stdout;
        const date = version.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        candidates.push({file, order: date ? `0-${date}/${file.includes("nightly-") ? 0 : 1}` : "2"});
      } catch { /* The official client also falls back when a component is unavailable. */ }
      break;
    }
  }
  if (candidates.length) return candidates.sort((a,b) => a.order.localeCompare(b.order))[0].file;
  const official = vscode.extensions.getExtension("rust-lang.rust-analyzer");
  if (!official) throw new Error("请先安装官方 rust-analyzer 扩展，再启用原始诊断中文显示。");
  const file = path.join(official.extensionPath, "server", process.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer");
  if (await exists(file)) return file;
  throw new Error("当前 rust-analyzer 没有附带服务器。请更新官方扩展，或通过 rust-analyzer.server.path 指定服务器。");
}
async function restart(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes("rust-analyzer.restartServer")) await vscode.commands.executeCommand("rust-analyzer.restartServer");
  else void vscode.window.showInformationMessage("设置已保存。请执行“Rust Analyzer: Restart Server”，或重新加载窗口。");
}

export function registerNativeCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): vscode.Disposable[] {
  let queue: Promise<unknown> = Promise.resolve();
  const run = (work: () => Promise<void>): Promise<unknown> => {
    queue = queue.then(work).catch(error => {
      output.appendLine(String(error));
      void vscode.window.showErrorMessage(`Rust 中文诊断：${error instanceof Error ? error.message : String(error)}`);
    });
    return queue;
  };
  async function enable(repair = false, savedScope?: {resource?: vscode.Uri; target: vscode.ConfigurationTarget; id: string}): Promise<void> {
    if (!["win32", "darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error("原始诊断中文显示支持 Windows、macOS 和 Linux 的 x64、ARM64。请安装与当前扩展运行环境匹配的 VSIX。");
    if (!vscode.workspace.isTrusted) throw new Error("请先信任当前项目，再启用原始诊断中文显示。");
    const {resource, target, id} = savedScope ?? scope();
    const config = vscode.workspace.getConfiguration("rust-analyzer", resource);
    const backups = context.workspaceState.get<Backups>(KEY, {});
    let backup = backups[id];
    const currentPath = config.get<string | null>("server.path");
    if (repair && (!backup || !same(layer(config, "server.path", target), backup.applied["server.path"]))) return;
    if (!backup && isProxy(currentPath)) {
      throw new Error("检测到旧版代理配置。请先执行“恢复原始诊断”，确认旧版备份，再重新启用；这样可避免把其他项目的设置恢复到这里。");
    }
    if (backup && !same(layer(config, "server.path", target), backup.applied["server.path"])) {
      throw new Error("服务器设置已在启用后修改。请先执行“恢复原始诊断”清理旧记录，再重新启用；你修改的服务器路径会保留。");
    }
    const custom = backup?.customServer ?? (currentPath && !isProxy(currentPath) ? currentPath : undefined);
    const real = await resolveServer(custom, resource);
    if (isProxy(real)) throw new Error("代理不能把自己作为原始服务器。请检查服务器路径。");
    const effectiveEnv = {...(config.get<ExtraEnv | null>("server.extraEnv") ?? {})};
    const envLayer = layer(config, "server.extraEnv", target);
    const env: ExtraEnv = {...((envLayer.value ?? {}) as ExtraEnv)};
    if (envLayer.present && envLayer.value === null) {
      const info = config.inspect<ExtraEnv | null>("server.extraEnv");
      const inherited = {...info?.defaultValue, ...info?.globalValue, ...(target === vscode.ConfigurationTarget.WorkspaceFolder ? info?.workspaceValue : {})};
      for (const key of Object.keys(inherited)) env[key] = null;
    }
    if (repair && backup && ENV_KEYS.some(key => !same(effectiveEnv[key], (backup.applied["server.extraEnv"].value as ExtraEnv)?.[key]))) return;
    const probeEnv = {...process.env};
    for (const [key, value] of Object.entries(effectiveEnv)) {
      if (value === null) delete probeEnv[key]; else probeEnv[key] = String(value);
    }
    await exec(real, ["--version"], {env: probeEnv, cwd: resource?.fsPath, timeout: 10000, windowsHide: true});
    // A versioned copy survives extension-directory cleanup and avoids overwriting a running EXE.
    const home = path.join(context.globalStorageUri.fsPath, "native", context.extension.packageJSON.version);
    await fs.mkdir(path.join(home, "bin"), {recursive: true});
    await fs.mkdir(path.join(home, "dist"), {recursive: true});
    const proxy = path.join(home, "bin", "rust-analyzer-lingo-proxy" + (process.platform === "win32" ? ".exe" : ""));
    if (!await exists(proxy)) await fs.copyFile(path.join(context.extensionPath, "out", "bin", path.basename(proxy)), proxy);
    if (process.platform !== "win32") await fs.chmod(proxy, 0o755);
    await fs.copyFile(path.join(context.extensionPath, "out", "dist", "catalog.json"), path.join(home, "dist", "catalog.json"));
    env[REAL] = real;
    env[LOCALE] = vscode.env.language;
    const applied: Record<string, SavedValue> = {"server.path": {present: true, value: proxy}, "server.extraEnv": {present: true, value: env}};
    if (backup && same(backup.applied, applied)) return;
    const before = Object.fromEntries(keys.map(key => [key, layer(config, key, target)]));
    backup ??= {resource: resource?.toString(), target, original: before, applied, customServer: custom};
    const original = {...backup.original};
    original["server.extraEnv"] = restoreEnv(before["server.extraEnv"], backup.applied["server.extraEnv"], backup.original["server.extraEnv"]);
    const next = {...backup, original, applied};
    // Journal before writing: a failed write or interrupted activation remains recoverable.
    await context.workspaceState.update(KEY, {...backups, [id]: next});
    try {
      await put(config, "server.extraEnv", applied["server.extraEnv"], target);
      await put(config, "server.path", applied["server.path"], target);
    } catch (error) {
      let rolledBack = true;
      for (const key of keys) await put(config, key, before[key], target).catch(e => { rolledBack = false; output.appendLine(`恢复 ${key} 失败：${e}`); });
      if (rolledBack) await context.workspaceState.update(KEY, backups);
      throw error;
    }
    await restart();
    output.appendLine(`原始诊断中文显示已连接：${real}`);
    if (!repair) void vscode.window.showInformationMessage("已为当前项目启用原始诊断中文显示。具体类型、修改建议和原文都会保留。");
  }
  async function disable(): Promise<void> {
    const backups = context.workspaceState.get<Backups>(KEY, {});
    const entries = Object.entries(backups);
    if (!entries.length) {
      const legacy = context.globalState.get<{serverPath: string | null; extraEnv: ExtraEnv | null; useRustcErrorCode?: boolean}>("previousNativeHoverSettings");
      const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      const config = vscode.workspace.getConfiguration("rust-analyzer", resource);
      const inspect = config.inspect("server.path");
      const target = isProxy(inspect?.workspaceFolderValue) ? vscode.ConfigurationTarget.WorkspaceFolder : isProxy(inspect?.workspaceValue) ? vscode.ConfigurationTarget.Workspace : isProxy(inspect?.globalValue) ? vscode.ConfigurationTarget.Global : undefined;
      if (!legacy || target === undefined) { void vscode.window.showInformationMessage("当前项目没有需要恢复的代理配置。"); return; }
      const answer = await vscode.window.showWarningMessage("旧版备份没有记录所属项目，无法自动确认是否适用于这里。", {modal: true, detail: `将恢复${target === vscode.ConfigurationTarget.Global ? "全局" : "当前项目"}服务器路径：${legacy.serverPath ?? "默认服务器"}。只有确认这是你原来的设置时才继续；取消不会更改设置。`}, "使用这份备份恢复");
      if (!answer) return;
      await config.update("server.path", legacy.serverPath ?? undefined, target);
      const envLayer = layer(config, "server.extraEnv", target);
      const env: ExtraEnv = {...((envLayer.value ?? {}) as ExtraEnv)};
      for (const key of ENV_KEYS) { if (legacy.extraEnv && key in legacy.extraEnv) env[key] = legacy.extraEnv[key]; else delete env[key]; }
      await config.update("server.extraEnv", Object.keys(env).length ? env : undefined, target);
      if (legacy.useRustcErrorCode !== undefined) await config.update("diagnostics.useRustcErrorCode", legacy.useRustcErrorCode, target);
      // Retain the unscoped legacy record: another workspace may still need it.
      await restart(); return;
    }
    for (const [id, backup] of entries) {
      const config = vscode.workspace.getConfiguration("rust-analyzer", backup.resource ? vscode.Uri.parse(backup.resource) : undefined);
      for (const key of keys) {
        const current = layer(config, key, backup.target);
        const value = key === "server.extraEnv" ? restoreEnv(current, backup.applied[key], backup.original[key])
          : same(current, backup.applied[key]) ? backup.original[key] : current;
        if (!same(value, current)) await put(config, key, value, backup.target);
      }
      delete backups[id];
      await context.workspaceState.update(KEY, backups);
    }
    await restart();
    void vscode.window.showInformationMessage("已恢复原始诊断。启用期间你自行修改的设置会保留。");
  }
  const repair = () => {
    for (const [id, backup] of Object.entries(context.workspaceState.get<Backups>(KEY, {}))) {
      void run(() => enable(true, {id, target: backup.target, resource: backup.resource ? vscode.Uri.parse(backup.resource) : undefined}));
    }
  };
  repair();
  return [
    vscode.commands.registerCommand("rustAnalyzerLingo.enableNativeChineseHover", () => run(() => enable())),
    vscode.commands.registerCommand("rustAnalyzerLingo.disableNativeChineseHover", () => run(disable)),
    vscode.extensions.onDidChange(repair)
  ];
}
