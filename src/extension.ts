import * as vscode from "vscode";
import { isProxy, registerNativeCommands } from "./native";
import {
  DiagnosticTranslation,
  getDiagnosticCode,
  originalMessage,
  translateDiagnostic
} from "./translation";

const EXTENSION_SOURCE = "rust-analyzer-lingo";
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

function getSettings(resource?: vscode.Uri): ExtensionSettings {
  const config = vscode.workspace.getConfiguration(EXTENSION_SOURCE, resource);
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
  return `${Array.from(text).slice(0, safeLength - 1).join("")}…`;
}

function uniqueEntries(
  entries: readonly TranslatedDiagnostic[]
): TranslatedDiagnostic[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = JSON.stringify([entry.original.message, entry.original.code, entry.original.range, entry.original.relatedInformation]);
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
    parts.push(`[${code}]`);
  }

  parts.push(translation.chinese);

  if (translation.explanation && translation.matchedBy !== "fallback") {
    parts.push(`可以这样检查：${translation.explanation}`);
  }

  const original = originalMessage(diagnostic.message);
  if (original !== translation.chinese) parts.push(`原文：${original}`);
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
      code: entry.original.code,
      tags: entry.original.tags,
      related: entry.original.relatedInformation,
      range: {
        start: [entry.original.range.start.line, entry.original.range.start.character],
        end: [entry.original.range.end.line, entry.original.range.end.character]
      }
    }))
  );
}

function severityLabel(severity: vscode.DiagnosticSeverity): string {
  return ["错误", "警告", "提示", "建议"][severity] ?? "提示";
}
function appendProse(markdown: vscode.MarkdownString, text: string): void {
  for (const part of text.split(/(`[^`\n]+`)/g)) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) markdown.appendMarkdown(part);
    else markdown.appendText(part);
  }
}
function makeTooltip(entries: readonly TranslatedDiagnostic[], _settings: ExtensionSettings): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  entries.forEach((entry, index) => {
    if (index) markdown.appendMarkdown("\n\n---\n\n");
    const code = getDiagnosticCode(entry.original);
    markdown.appendMarkdown("### ");
    markdown.appendText(severityLabel(entry.original.severity) + (code ? ` · ${code}` : ""));
    markdown.appendMarkdown("\n\n");
    appendProse(markdown, entry.translation.chinese);
    if (entry.translation.explanation && entry.translation.matchedBy !== "fallback") {
      markdown.appendMarkdown("\n\n**可以这样检查**\n\n");
      appendProse(markdown, entry.translation.explanation);
    }
    const original = originalMessage(entry.original.message);
    if (original !== entry.translation.chinese) {
      markdown.appendMarkdown("\n\n**编译器原文**\n\n");
      markdown.appendText(original);
    }
    const related = entry.original.relatedInformation ?? [];
    if (related.length) {
      markdown.appendMarkdown("\n\n**相关位置**\n\n");
      for (const item of related) {
        markdown.appendText(`${vscode.workspace.asRelativePath(item.location.uri)}:${item.location.range.start.line + 1} — ${item.message}`);
        markdown.appendMarkdown("\n\n");
      }
    }
    if (code?.match(/^E\d{4}$/)) markdown.appendMarkdown(`\n\n[查看 Rust 官方解释](https://doc.rust-lang.org/error_codes/${code}.html)`);
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
  const first = [...distinctEntries].sort((a, b) => a.original.severity - b.original.severity)[0];
  const additionalCount = distinctEntries.length - 1;
  const suffix = additionalCount > 0 ? ` · 另 ${additionalCount} 条` : "";
  const label = `${severityLabel(first.original.severity)}：${truncateText(first.translation.chinese, settings.inlineTextMaxLength)}${suffix}`;
  const hint = new vscode.InlayHint(
    position,
    label,
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
  const displaySignatures = new Map<string, string>();
  const pending = new Map<string, vscode.Uri>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  status.command = "rustAnalyzerLingo.showMenu";
  const modeNames: Record<DisplayMode, string> = {inline: "行尾提示", hover: "悬停解释", problems: "问题面板", both: "悬停与问题面板"};
  const updateStatus = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "rust") {status.hide(); return;}
    const entries = translatedByUri.get(editor.document.uri.toString()) ?? [];
    const errors = entries.filter(e => e.original.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = entries.filter(e => e.original.severity === vscode.DiagnosticSeverity.Warning).length;
    status.text = `$(comment-discussion) Rust 中文${errors ? ` · $(error) ${errors}` : ""}${warnings ? ` · $(warning) ${warnings}` : ""}`;
    const native = isProxy(vscode.workspace.getConfiguration("rust-analyzer", editor.document.uri).get("server.path"));
    status.tooltip = `数量仅统计已有中文解释的问题。当前显示：${modeNames[getSettings(editor.document.uri).mode]}；原始诊断：${native ? "已连接中文代理" : "默认"}。点击切换显示方式、查看解释或设置原始诊断中文显示。`;
    status.show();
  };
  context.subscriptions.push(status, vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidOpenTextDocument(doc => {if (doc.languageId === "rust") schedule(doc.uri);}),
    vscode.commands.registerCommand("rustAnalyzerLingo.showMenu", async () => {
      const native = isProxy(vscode.workspace.getConfiguration("rust-analyzer", vscode.window.activeTextEditor?.document.uri).get("server.path"));
      const selected = await vscode.window.showQuickPick([
        {label: "$(list-selection) 切换中文提示的位置", command: "rustAnalyzerLingo.chooseMode"},
        {label: "$(info) 解释光标处的问题", command: "rustAnalyzerLingo.explainCurrentDiagnostic"},
        {label: native ? "$(check) 原始诊断已连接中文代理" : "$(globe) 在原始诊断中显示中文", description: native ? "点击检查或更新连接" : "当前项目", command: "rustAnalyzerLingo.enableNativeChineseHover"},
        {label: "$(discard) 恢复原始诊断", command: "rustAnalyzerLingo.disableNativeChineseHover"}
      ], {title: "Rust 中文诊断", placeHolder: "你想做什么？"});
      if (selected) await vscode.commands.executeCommand(selected.command);
    }),
    vscode.commands.registerCommand("rustAnalyzerLingo.chooseMode", async () => {
      const options: Array<{label: string; description: string; mode: DisplayMode}> = [
        {label: "行尾提示", description: "推荐：快速看懂问题，悬停查看细节", mode: "inline"},
        {label: "悬停解释", description: "保持编辑区清爽，鼠标移到错误处查看", mode: "hover"},
        {label: "问题面板", description: "在 Problems 中追加中文条目，会保留原始条目", mode: "problems"},
        {label: "悬停与问题面板", description: "同时使用这两种显示方式", mode: "both"}
      ];
      const selected = await vscode.window.showQuickPick(options, {title: "中文提示显示在哪里？"});
      if (selected) {
        if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) {
          void vscode.window.showInformationMessage("请先打开项目文件夹，再保存显示方式。当前保持原来的显示方式。"); return;
        }
        const resource = vscode.window.activeTextEditor?.document.uri;
        const config = vscode.workspace.getConfiguration(EXTENSION_SOURCE, resource);
        const target = config.inspect("mode")?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
        await config.update("mode", selected.mode, target);
      }
    })
  );
  const refreshDiagnostics = async (uri: vscode.Uri): Promise<void> => {
    if (uri.scheme !== "file" && uri.scheme !== "untitled") {
      return;
    }

    let document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (!document) {
      if (!isProblemsMode(getSettings(uri)) || !uri.path.endsWith(".rs") || !vscode.languages.getDiagnostics(uri).some(d => d.source !== EXTENSION_SOURCE && isRustDiagnostic(d))) return;
      try { document = await vscode.workspace.openTextDocument(uri); } catch { return; }
    }
    if (disposed) return;

    const uriKey = uri.toString();
    if (document.languageId !== "rust") {
      translatedByUri.delete(uriKey);
      displaySignatures.delete(uriKey);
      problemSignatures.delete(uriKey);
      bilingualDiagnostics.delete(uri);
      inlayHintChanges.fire();
      return;
    }

    const settings = getSettings(uri);
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

    const signature = makeProblemSignature(entries, settings);
    translatedByUri.set(uriKey, entries);
    if (displaySignatures.get(uriKey) !== signature) {
      displaySignatures.set(uriKey, signature);
      inlayHintChanges.fire();
    }
    updateStatus();

    if (isProblemsMode(settings)) {
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

  const schedule = (uri: vscode.Uri): void => {
    pending.set(uri.toString(), uri);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const batch = [...pending.values()]; pending.clear();
      void Promise.all(batch.map(refreshDiagnostics)).catch(error => output.appendLine(String(error)));
    }, 80);
  };
  const refreshOpenDocuments = (): void => {
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === "rust") schedule(document.uri);
    }
  };

  context.subscriptions.push(
    ...registerNativeCommands(context, output),
    {dispose() {disposed = true; if (timer) clearTimeout(timer); pending.clear();}},
    bilingualDiagnostics,
    inlayHintChanges,
    output,
    vscode.languages.onDidChangeDiagnostics((event) => {
      for (const uri of event.uris) {
        schedule(uri);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const uriKey = document.uri.toString();
      translatedByUri.delete(uriKey);
      displaySignatures.delete(uriKey);
      problemSignatures.delete(uriKey);
      bilingualDiagnostics.delete(document.uri);
      inlayHintChanges.fire();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("rust-analyzer.server")) updateStatus();
      if (event.affectsConfiguration(EXTENSION_SOURCE)) {
        if (!isProblemsMode(getSettings())) { bilingualDiagnostics.clear(); problemSignatures.clear(); }
        inlayHintChanges.fire();
        updateStatus();
        refreshOpenDocuments();
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: "rust", scheme: "file" }, { language: "rust", scheme: "untitled" }],
      {
        provideHover(document, position): vscode.Hover | undefined {
          const settings = getSettings(document.uri);
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
      [{ language: "rust", scheme: "file" }, { language: "rust", scheme: "untitled" }],
      {
        onDidChangeInlayHints: inlayHintChanges.event,
        provideInlayHints(document, range): vscode.InlayHint[] {
          const settings = getSettings(document.uri);
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

        const entries = vscode.languages.getDiagnostics(editor.document.uri)
          .filter(d => d.source !== EXTENSION_SOURCE && isRustDiagnostic(d) && positionMatches(d, editor.selection.active, true))
          .map(original => ({original, translation: translateDiagnostic(original)}));

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
          output.appendLine(entry.translation.chinese);
          if (entry.translation.explanation) {
            output.appendLine(`可以这样检查：${entry.translation.explanation}`);
          }
          output.appendLine(`编译器原文：${originalMessage(entry.original.message)}`);
        }

        output.show(true);
      }
    )
  );

  updateStatus();
  refreshOpenDocuments();
}

export function deactivate(): void {
  // 所有资源都通过 context.subscriptions 注册，会由 VS Code 自动释放。
}
