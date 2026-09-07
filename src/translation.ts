import type * as vscode from "vscode";
import diagnosticDetails from "./diagnostic-details.json";
import messageRules from "./message-rules.json";
import { RUST_ERROR_CODE_TITLES } from "./error-codes";

export type TranslationMatch = "code" | "message" | "fallback";

export interface DiagnosticTranslation {
  chinese: string;
  explanation?: string;
  matchedBy: TranslationMatch;
}

interface StaticTranslation {
  chinese: string;
  explanation?: string;
}

const CATALOG_TRANSLATIONS: Readonly<Record<string, StaticTranslation>> =
  Object.fromEntries(
    Object.entries(RUST_ERROR_CODE_TITLES).map(([code, chinese]) => [code, { chinese }])
  );

const CODE_TRANSLATIONS: Readonly<Record<string, StaticTranslation>> = {
  ...CATALOG_TRANSLATIONS,
  ...diagnosticDetails
};


/**
 * rustc 的 Diagnostic.code 既可能是字符串/数字，也可能是带 value 的对象。
 * 统一转换后，词典可以稳定地使用 E0384 这样的错误代码作为 key。
 */
export function getDiagnosticCode(diagnostic: vscode.Diagnostic): string | undefined {
  const rawCode = diagnostic.code;
  if (rawCode && typeof rawCode === "object" && "target" in rawCode) {
    const linkedCode = String(rawCode.target).match(/(?:error_codes\/|error-index\.html#|[?&]code=)(E\d{4})/i)?.[1];
    if (linkedCode) return linkedCode.toUpperCase();
  }

  if (typeof rawCode === "string" || typeof rawCode === "number") {
    return normalizeDiagnosticCode(rawCode);
  }

  if (rawCode && typeof rawCode === "object" && "value" in rawCode) {
    const value = rawCode.value;
    if (typeof value === "string" || typeof value === "number") {
      return normalizeDiagnosticCode(value);
    }
  }

  return undefined;
}

function normalizeDiagnosticCode(value: string | number): string | undefined {
  const raw = String(value).trim();
  if (!raw || /click for full compiler diagnostics?/i.test(raw)) {
    return undefined;
  }

  const errorCode = raw.match(/E\d{4}/i)?.[0];
  return errorCode ? errorCode.toUpperCase() : raw;
}

export function translateDiagnostic(diagnostic: vscode.Diagnostic): DiagnosticTranslation {
  diagnostic = { ...diagnostic, message: originalMessage(diagnostic.message) };
  const code = getDiagnosticCode(diagnostic);
  const contextual = translateContext(diagnostic.message);
  if (contextual) return contextual;
  const rule = messageRules.find(item => item.any.some(phrase => diagnostic.message.toLowerCase().includes(phrase)));
  if (rule) return {chinese: rule.chinese, explanation: rule.explanation, matchedBy: "message"};
  const normalizedCode = code?.match(/E\d{4}/)?.[0];

  if (normalizedCode && CODE_TRANSLATIONS[normalizedCode]) {
    return {
      ...CODE_TRANSLATIONS[normalizedCode],
      matchedBy: "code"
    };
  }

  if (normalizedCode) {
    return {
      chinese: `Rust 编译错误 ${normalizedCode}`,
      explanation: "请结合错误位置、代码上下文和编译器提供的修改建议进行检查。",
      matchedBy: "fallback"
    };
  }

  const message = diagnostic.message.replace(/\r?\n/g, " ").trim();

  const overflow = message.match(/literal out of range for\s+[`']([^`']+)[`']/i);
  if (overflow) {
    const targetType = overflow[1];
    return {
      chinese: `整数字面量超出了 ${targetType} 的取值范围`,
      explanation: `当前数值无法存入 ${targetType}；请减小数值，或改用范围更大的整数类型。`,
      matchedBy: "message"
    };
  }


  return {
    chinese: "暂无详细中文说明",
    explanation: "这是一条 Rust 诊断提示，当前词典还没有针对它的详细解释。",
    matchedBy: "fallback"
  };
}

/** Match compiler prose, keeping identifiers and types exactly as supplied. */
export function translateContext(message: string): DiagnosticTranslation | undefined {
  const firstLine = message.split(/\r?\n/)[0].trim();
  const rules: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string, string]> = [
    [/^unused variable: [`'](.+)[`']$/i, m => "变量 `" + m[1] + "` 没有使用", "不需要这个变量时可以删除；有意保留时，在名称前加下划线。"],
    [/^unused import: [`'](.+)[`']$/i, m => "导入的 `" + m[1] + "` 没有使用", "删除不需要的 use 导入，或使用导入的内容。"],
    [/^cannot find (?:value|function|type|struct|module) [`'](.+)[`'] in this scope/i, m => "当前作用域找不到 `" + m[1] + "`", "检查名称拼写，确认已经定义或通过 use 导入。"],
    [/^use of moved value: [`'](.+)[`']/i, m => "`" + m[1] + "` 已经被移动，不能再次使用", diagnosticDetails.E0382.explanation],
    [/^no method named [`'](.+?)[`'] found for (.+)/i, m => m[2] + " 上找不到方法 `" + m[1] + "`", "检查方法名和接收者类型；如果方法来自 trait，请确认已经 use 导入。"],
    [/^the trait bound [`'](.+?)[`'] is not satisfied/i, m => "未满足约束：`" + m[1] + "`", diagnosticDetails.E0277.explanation]
  ];
  for (const [pattern, title, explanation] of rules) {
    const match = firstLine.match(pattern);
    if (match) return {chinese: title(match), explanation, matchedBy: "message"};
  }
  const args = firstLine.match(/^expected (\d+) arguments?, found (\d+)$/);
  if (args) return {chinese: `需要 ${args[1]} 个参数，实际传了 ${args[2]} 个`, explanation: diagnosticDetails.E0061.explanation, matchedBy: "message"};
  const simpleTypes = firstLine.match(/^expected (.+), found (.+)$/);
  if (simpleTypes) return {chinese: `需要 ${simpleTypes[1]}，实际是 ${simpleTypes[2]}`, explanation: diagnosticDetails.E0308.explanation, matchedBy: "message"};
  const types = message.match(/expected (?:type )?([`'][^`'\n]+[`'])[ ,\r\n]+found (?:type )?([`'][^`'\n]+[`'])/i);
  if (types) return {chinese: `需要 ${types[1]}，实际是 ${types[2]}`, explanation: diagnosticDetails.E0308.explanation, matchedBy: "message"};
  return undefined;
}

export function originalMessage(message: string): string {
  const marker = "\n\n原文：\n";
  const index = message.indexOf(marker);
  return message.startsWith("中文：") && index >= 0 ? message.slice(index + marker.length) : message;
}
