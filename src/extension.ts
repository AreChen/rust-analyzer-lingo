import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DiagnosticTranslation,
  getDiagnosticCode,
  translateDiagnostic
} from "./translation";

const EXTENSION_SOURCE = "rust-analyzer-lingo";
const PREVIOUS_NATIVE_SETTINGS_KEY = "previousNativeHoverSettings";
const REAL_SERVER_ENV = "RUST_ANALYZER_LINGO_REAL_SERVER";
const LOCALE_ENV = "RUST_ANALYZER_LINGO_LOCALE";
const RUST_DIAGNOSTIC_SOURCES = new Set([
  "rust-analyzer",
  "rustc",
  "clippy"
]);

type DisplayMode = "inline" | "hover" | "problems" | "both";

interface ExtensionSettings {
  mode: DisplayMode;
  showFallback: boolean;
  inlineTextMaxLength: number;
}

interface TranslatedDiagnostic {
  original: vscode.Diagnostic;
  translation: DiagnosticTranslation;
}

interface PreviousNativeSettings {
  serverPath: string | null;
  extraEnv: Record<string, string> | null;
  useRustcErrorCode?: boolean;
}

function getDiagnosticSourceLabel(language = vscode.env.language): string {
  const locale = language.trim().toLowerCase().replaceAll("_", "-");

  if (
    locale.startsWith("zh-tw") ||
    locale.startsWith("zh-hk") ||
    locale.startsWith("zh-mo") ||
    locale.startsWith("zh-hant")
  ) {
    return "Rust 中文診斷";
  }
  if (locale.startsWith("zh")) {
    return "Rust 中文诊断";
  }

  const labels: ReadonlyArray<readonly [string, string]> = [
    ["ja", "Rust 診断"],
    ["ko", "Rust 진단"],
    ["de", "Rust-Diagnose"],
    ["fr", "Diagnostics Rust"],
    ["es", "Diagnósticos de Rust"],
    ["pt", "Diagnósticos do Rust"],
    ["ru", "Диагностика Rust"]
  ];
  return labels.find(([prefix]) => locale.startsWith(prefix))?.[1] ?? "Rust Diagnostics";
}

function getWorkspaceConfigurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function getProxyPath(context: vscode.ExtensionContext): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const proxyPath = path.join(
    context.extensionPath,
    "bin",
    "rust-analyzer-lingo-proxy.exe"
  );
  return fs.existsSync(proxyPath) ? proxyPath : undefined;
}

function getBundledRustAnalyzerPath(): string | undefined {
  const extension = vscode.extensions.getExtension("rust-lang.rust-analyzer");
  if (!extension) {
    return undefined;
  }

  const serverName = process.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer";
  const serverPath = path.join(extension.extensionPath, "server", serverName);
  return fs.existsSync(serverPath) ? serverPath : undefined;
}

async function restartRustAnalyzer(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes("rust-analyzer.restartServer")) {
    await vscode.commands.executeCommand("rust-analyzer.restartServer");
    return;
  }

  void vscode.window.showInformationMessage(
    "配置已保存。请执行“Rust Analyzer: Restart Server”让原生中文 Hover 生效。"
  );
}

async function enableNativeChineseHover(
  context: vscode.ExtensionContext
): Promise<void> {
  const proxyPath = getProxyPath(context);
  if (!proxyPath) {
    void vscode.window.showErrorMessage(
      "当前系统暂未提供 rust-analyzer-lingo 的原生 Hover 代理；目前只支持 Windows x64。"
    );
    return;
  }

  const rustAnalyzer = vscode.workspace.getConfiguration("rust-analyzer");
  const target = getWorkspaceConfigurationTarget();
  const previous = context.globalState.get<PreviousNativeSettings>(
    PREVIOUS_NATIVE_SETTINGS_KEY
  );

  if (!previous) {
    await context.globalState.update(PREVIOUS_NATIVE_SETTINGS_KEY, {
      serverPath: rustAnalyzer.get<string | null>("server.path", null),
      extraEnv: rustAnalyzer.get<Record<string, string> | null>("server.extraEnv", null),
      useRustcErrorCode: rustAnalyzer.get<boolean>(
        "diagnostics.useRustcErrorCode",
        false
      )
    } satisfies PreviousNativeSettings);
  } else if (previous.useRustcErrorCode === undefined) {
    await context.globalState.update(PREVIOUS_NATIVE_SETTINGS_KEY, {
      ...previous,
      useRustcErrorCode: rustAnalyzer.get<boolean>(
        "diagnostics.useRustcErrorCode",
        false
      )
    } satisfies PreviousNativeSettings);
  }

  const extraEnv = {
    ...(rustAnalyzer.get<Record<string, string> | null>("server.extraEnv", null) ?? {})
  };
  extraEnv[LOCALE_ENV] = vscode.env.language;
  const bundledServerPath = getBundledRustAnalyzerPath();
  if (bundledServerPath) {
    extraEnv[REAL_SERVER_ENV] = bundledServerPath;
  } else {
    delete extraEnv[REAL_SERVER_ENV];
  }

  await rustAnalyzer.update("server.extraEnv", extraEnv, target);
  await rustAnalyzer.update("server.path", proxyPath, target);
  // rust-analyzer 默认会把诊断代码替换成硬编码的英文链接文本。
  // 使用原始 rustc 代码后，Hover 会显示 E0308、overflowing_literals 等稳定标识。
  await rustAnalyzer.update("diagnostics.useRustcErrorCode", true, target);
  await restartRustAnalyzer();

  void vscode.window.showInformationMessage(
    "已启用原生 Hover 中文替换。rust-analyzer 的诊断悬停卡片现在会由代理翻译。"
  );
}

async function disableNativeChineseHover(
  context: vscode.ExtensionContext
): Promise<void> {
  const previous = context.globalState.get<PreviousNativeSettings>(
    PREVIOUS_NATIVE_SETTINGS_KEY
  );
  if (!previous) {
    void vscode.window.showInformationMessage("当前没有 rust-analyzer-lingo 保存的原生 Hover 配置。");
    return;
  }

  const rustAnalyzer = vscode.workspace.getConfiguration("rust-analyzer");
  const target = getWorkspaceConfigurationTarget();
  await rustAnalyzer.update("server.path", previous.serverPath, target);
  await rustAnalyzer.update("server.extraEnv", previous.extraEnv, target);
  if (previous.useRustcErrorCode !== undefined) {
    await rustAnalyzer.update(
      "diagnostics.useRustcErrorCode",
      previous.useRustcErrorCode,
      target
    );
  }
  await context.globalState.update(PREVIOUS_NATIVE_SETTINGS_KEY, undefined);
  await restartRustAnalyzer();

  void vscode.window.showInformationMessage("已恢复 rust-analyzer 的原始服务器配置。");
}

function getSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration(EXTENSION_SOURCE);
  return {
    mode: config.get<DisplayMode>("mode", "inline"),
    showFallback: config.get<boolean>("showFallback", false),
    inlineTextMaxLength: config.get<number>("inlineTextMaxLength", 32)
  };
}

function isInlineMode(settings: ExtensionSettings): boolean {
  return settings.mode === "inline";
}

function isHoverMode(settings: ExtensionSettings): boolean {
  return settings.mode === "hover" || settings.mode === "both";
}

function isProblemsMode(settings: ExtensionSettings): boolean {
  return settings.mode === "problems" || settings.mode === "both";
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const safeLength = Math.max(4, maxLength);
  return `${text.slice(0, safeLength - 1)}…`;
}

function uniqueEntries(
  entries: readonly TranslatedDiagnostic[]
): TranslatedDiagnostic[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.translation.chinese}\n${entry.translation.explanation ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isRustDiagnostic(diagnostic: vscode.Diagnostic): boolean {
  const source = diagnostic.source?.toLowerCase();
  const code = getDiagnosticCode(diagnostic);

  return Boolean(
    (source && RUST_DIAGNOSTIC_SOURCES.has(source)) ||
      source?.includes("rust") ||
      code?.match(/^E\d{4}$/)
  );
}

function positionMatches(
  diagnostic: vscode.Diagnostic,
  position: vscode.Position,
  allowLineFallback = false
): boolean {
  const range = diagnostic.range;
  if (range.contains(position)) {
    return true;
  }

  return (
    allowLineFallback &&
    position.line >= range.start.line &&
    position.line <= range.end.line
  );
}

function makeChineseMessage(
  diagnostic: vscode.Diagnostic,
  translation: DiagnosticTranslation,
  _settings: ExtensionSettings
): string {
  const parts: string[] = [];
  const code = getDiagnosticCode(diagnostic);

  if (code) {
    parts.push(`错误代码：${code}`);
  }

  parts.push(`提示：${translation.chinese}`);

  if (translation.explanation && translation.matchedBy !== "fallback") {
    parts.push(`解释：${translation.explanation}`);
  }

  return parts.join("\n");
}

function makeProblemDiagnostic(
  entry: TranslatedDiagnostic,
  settings: ExtensionSettings
): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    entry.original.range,
    makeChineseMessage(entry.original, entry.translation, settings),
    entry.original.severity
  );

  // 保留稳定的内部来源 ID，refreshDiagnostics 依靠它排除扩展自己创建的诊断。
  diagnostic.source = EXTENSION_SOURCE;
  diagnostic.code = entry.original.code;
  diagnostic.tags = entry.original.tags;
  diagnostic.relatedInformation = entry.original.relatedInformation;

  return diagnostic;
}

function makeProblemSignature(
  entries: readonly TranslatedDiagnostic[],
  settings: ExtensionSettings
): string {
  return JSON.stringify(
    entries.map((entry) => ({
      message: makeChineseMessage(entry.original, entry.translation, settings),
      severity: entry.original.severity,
      source: entry.original.source,
      code: getDiagnosticCode(entry.original),
      range: {
        start: [entry.original.range.start.line, entry.original.range.start.character],
        end: [entry.original.range.end.line, entry.original.range.end.character]
      }
    }))
  );
}

function makeTooltip(
  entries: readonly TranslatedDiagnostic[],
  settings: ExtensionSettings
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  markdown.appendText(getDiagnosticSourceLabel());
  markdown.appendMarkdown("\n\n");

  entries.forEach((entry, index) => {
    if (index > 0) {
      markdown.appendMarkdown("\n---\n\n");
    }

    const code = getDiagnosticCode(entry.original);
    if (code) {
      markdown.appendText(`错误代码：${code}`);
      markdown.appendMarkdown("\n\n");
    }

    markdown.appendText(`提示：${entry.translation.chinese}`);

    if (entry.translation.explanation && entry.translation.matchedBy !== "fallback") {
      markdown.appendMarkdown("\n\n");
      markdown.appendText(`解释：${entry.translation.explanation}`);
    }
  });

  return markdown;
}

function makeInlayHint(
  document: vscode.TextDocument,
  entries: readonly TranslatedDiagnostic[],
  settings: ExtensionSettings
): vscode.InlayHint {
  const distinctEntries = uniqueEntries(entries);
  const line = Math.min(
    Math.max(...distinctEntries.map((entry) => entry.original.range.end.line)),
    document.lineCount - 1
  );
  const position = new vscode.Position(line, document.lineAt(line).text.length);
  const first = distinctEntries[0];
  const additionalCount = distinctEntries.length - 1;
  const suffix = additionalCount > 0 ? `（另有 ${additionalCount} 条相关提示）` : "";
  const label = `提示：${first.translation.chinese}${suffix}`;
  const hint = new vscode.InlayHint(
    position,
    truncateText(label, settings.inlineTextMaxLength),
    vscode.InlayHintKind.Type
  );

  hint.paddingLeft = true;
  hint.paddingRight = true;
  hint.tooltip = makeTooltip(distinctEntries, settings);
  return hint;
}

export function activate(context: vscode.ExtensionContext): void {
  const bilingualDiagnostics = vscode.languages.createDiagnosticCollection(
    EXTENSION_SOURCE
  );
  const inlayHintChanges = new vscode.EventEmitter<void>();
  const output = vscode.window.createOutputChannel(EXTENSION_SOURCE);
  const translatedByUri = new Map<string, TranslatedDiagnostic[]>();
  const problemSignatures = new Map<string, string>();

  const refreshDiagnostics = async (uri: vscode.Uri): Promise<void> => {
    if (uri.scheme !== "file" && uri.scheme !== "untitled") {
      return;
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      return;
    }

    const uriKey = uri.toString();
    if (document.languageId !== "rust") {
      translatedByUri.delete(uriKey);
      problemSignatures.delete(uriKey);
      bilingualDiagnostics.delete(uri);
      inlayHintChanges.fire();
      return;
    }

    const settings = getSettings();
    const entries = vscode.languages
      .getDiagnostics(uri)
      .filter((diagnostic) =>
        diagnostic.source !== EXTENSION_SOURCE && isRustDiagnostic(diagnostic)
      )
      .map((diagnostic) => ({
        original: diagnostic,
        translation: translateDiagnostic(diagnostic)
      }))
      .filter(
        (entry) => settings.showFallback || entry.translation.matchedBy !== "fallback"
      );

    translatedByUri.set(uriKey, entries);
    inlayHintChanges.fire();

    if (isProblemsMode(settings)) {
      const signature = makeProblemSignature(entries, settings);
      if (problemSignatures.get(uriKey) !== signature) {
        bilingualDiagnostics.set(
          uri,
          entries.map((entry) => makeProblemDiagnostic(entry, settings))
        );
        problemSignatures.set(uriKey, signature);
      }
    } else {
      bilingualDiagnostics.delete(uri);
      problemSignatures.delete(uriKey);
    }
  };

  const refreshOpenDocuments = (): void => {
    for (const document of vscode.workspace.textDocuments) {
      void refreshDiagnostics(document.uri);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("rustAnalyzerLingo.enableNativeChineseHover", () =>
      enableNativeChineseHover(context)
    ),
    vscode.commands.registerCommand("rustAnalyzerLingo.disableNativeChineseHover", () =>
      disableNativeChineseHover(context)
    ),
    bilingualDiagnostics,
    inlayHintChanges,
    output,
    vscode.languages.onDidChangeDiagnostics((event) => {
      for (const uri of event.uris) {
        void refreshDiagnostics(uri);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const uriKey = document.uri.toString();
      translatedByUri.delete(uriKey);
      problemSignatures.delete(uriKey);
      bilingualDiagnostics.delete(document.uri);
      inlayHintChanges.fire();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(EXTENSION_SOURCE)) {
        refreshOpenDocuments();
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { language: "rust", scheme: "file" },
      {
        provideHover(document, position): vscode.Hover | undefined {
          const settings = getSettings();
          if (!isHoverMode(settings)) {
            return undefined;
          }

          const entries = (translatedByUri.get(document.uri.toString()) ?? []).filter(
            (entry) => positionMatches(entry.original, position)
          );

          return entries.length > 0
            ? new vscode.Hover(makeTooltip(entries, settings))
            : undefined;
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      { language: "rust", scheme: "file" },
      {
        onDidChangeInlayHints: inlayHintChanges.event,
        provideInlayHints(document, range): vscode.InlayHint[] {
          const settings = getSettings();
          if (!isInlineMode(settings)) {
            return [];
          }

          const entries = (translatedByUri.get(document.uri.toString()) ?? []).filter(
            (entry) => {
              const line = entry.original.range.end.line;
              return line >= range.start.line && line <= range.end.line;
            }
          );

          const entriesByLine = new Map<number, TranslatedDiagnostic[]>();
          for (const entry of entries) {
            const line = entry.original.range.end.line;
            const lineEntries = entriesByLine.get(line) ?? [];
            lineEntries.push(entry);
            entriesByLine.set(line, lineEntries);
          }

          return [...entriesByLine.values()].map((lineEntries) =>
            makeInlayHint(document, lineEntries, settings)
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rustAnalyzerLingo.explainCurrentDiagnostic",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== "rust") {
          void vscode.window.showWarningMessage("请先打开一个 Rust 文件。");
          return;
        }

        await refreshDiagnostics(editor.document.uri);

        const entries = (translatedByUri.get(editor.document.uri.toString()) ?? []).filter(
          (entry) => positionMatches(entry.original, editor.selection.active, true)
        );

        if (entries.length === 0) {
          void vscode.window.showInformationMessage(
            "当前位置没有检测到 Rust 诊断。"
          );
          return;
        }

        output.clear();
        output.appendLine(getDiagnosticSourceLabel());
        output.appendLine("============");

        for (const [index, entry] of entries.entries()) {
          if (index > 0) {
            output.appendLine("");
          }

          const code = getDiagnosticCode(entry.original);
          if (code) {
            output.appendLine(`错误代码：${code}`);
          }
          output.appendLine(`提示：${entry.translation.chinese}`);
          if (entry.translation.explanation) {
            output.appendLine(`解释：${entry.translation.explanation}`);
          }
        }

        output.show(true);
      }
    )
  );

  refreshOpenDocuments();
}

export function deactivate(): void {
  // 所有资源都通过 context.subscriptions 注册，会由 VS Code 自动释放。
}
