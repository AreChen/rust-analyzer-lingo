import * as vscode from "vscode";
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
  E0004: {
    chinese: "模式匹配不完整",
    explanation: "match 表达式没有覆盖所有可能的情况。"
  },
  E0015: {
    chinese: "常量中不能调用非 const 函数",
    explanation: "常量初始化只能调用允许在编译期执行的 const 函数。"
  },
  E0026: {
    chinese: "结构体模式中没有这个字段",
    explanation: "请检查字段名，或者确认匹配的结构体类型是否正确。"
  },
  E0027: {
    chinese: "结构体模式没有覆盖所有字段",
    explanation: "请补充缺少的字段，或使用 .. 忽略其余字段。"
  },
  E0034: {
    chinese: "找到多个同名候选项",
    explanation: "多个 trait 或实现提供了同名方法，需要使用更明确的调用路径。"
  },
  E0046: {
    chinese: "trait 的所有必需项还没有实现",
    explanation: "实现 trait 时必须提供它要求的所有方法、类型或常量。"
  },
  E0053: {
    chinese: "trait 方法的签名不匹配",
    explanation: "实现中的方法参数、返回类型或生命周期必须与 trait 定义兼容。"
  },
  E0061: {
    chinese: "函数或方法的参数数量不正确",
    explanation: "传入的参数数量与定义不一致。"
  },
  E0106: {
    chinese: "缺少生命周期说明符",
    explanation: "返回的引用或结构体字段需要明确说明生命周期。"
  },
  E0107: {
    chinese: "泛型参数数量不正确",
    explanation: "提供的泛型参数数量与类型、函数或 trait 的定义不一致。"
  },
  E0117: {
    chinese: "违反 trait 实现的孤儿规则",
    explanation: "只有 trait 或实现类型至少有一个定义在当前 crate 中时，才能实现这个 trait。"
  },
  E0119: {
    chinese: "trait 实现发生冲突",
    explanation: "当前类型存在两个都可能适用的 trait 实现。"
  },
  E0133: {
    chinese: "调用 unsafe 操作需要 unsafe 代码块",
    explanation: "请在明确承担安全责任的 unsafe {} 中执行这个操作。"
  },
  E0184: {
    chinese: "这个类型不能实现 Copy",
    explanation: "带有析构函数或其他不满足 Copy 要求的类型不能实现 Copy。"
  },
  E0191: {
    chinese: "trait 对象缺少关联类型",
    explanation: "使用带有关联类型的 trait 对象时，需要指定关联类型的具体值。"
  },
  E0207: {
    chinese: "泛型参数没有被约束",
    explanation: "这个泛型参数没有出现在实现、trait 或方法签名的有效约束中。"
  },
  E0277: {
    chinese: "此类型不满足所需的 trait 约束",
    explanation: "当前类型没有实现代码要求的 trait。"
  },
  E0271: {
    chinese: "关联类型解析后仍然不匹配",
    explanation: "trait 约束要求的关联类型与实际解析出的类型不同。"
  },
  E0282: {
    chinese: "无法推断类型",
    explanation: "请提供类型标注，让编译器知道这个值或泛型参数的具体类型。"
  },
  E0283: {
    chinese: "类型推断存在多个可能性",
    explanation: "请补充类型标注或 trait 约束，帮助编译器选择唯一的实现。"
  },
  E0308: {
    chinese: "类型不匹配",
    explanation: "表达式实际产生的类型与当前位置期望的类型不同。"
  },
  E0369: {
    chinese: "这个二元运算不能用于当前类型",
    explanation: "参与运算的类型没有实现所需的运算 trait，或两边类型不兼容。"
  },
  E0373: {
    chinese: "闭包可能比当前函数活得更久",
    explanation: "闭包捕获了局部变量，但闭包可能在这些变量失效后才执行。"
  },
  E0381: {
    chinese: "变量可能尚未初始化",
    explanation: "某条执行路径使用了变量，但这条路径上变量还没有被赋值。"
  },
  E0382: {
    chinese: "使用了已经被移动的值",
    explanation: "值被 move 后，原变量通常不能再次使用；可以考虑借用、Clone 或调整所有权转移。"
  },
  E0384: {
    chinese: "不能给不可变变量再次赋值",
    explanation: "使用 let 创建的变量默认不可修改。如果需要修改，请使用 let mut。"
  },
  E0391: {
    chinese: "检测到类型或 trait 依赖循环",
    explanation: "编译器在解析定义时发现了循环依赖，请拆分或调整相关定义。"
  },
  E0412: {
    chinese: "当前作用域中找不到这个类型",
    explanation: "请检查类型名拼写、模块路径以及是否需要使用 use 引入。"
  },
  E0425: {
    chinese: "当前作用域中找不到这个名称",
    explanation: "变量、函数或常量的名称可能拼写错误，或者没有被正确引入。"
  },
  E0432: {
    chinese: "无法解析导入",
    explanation: "use 语句引用的模块、类型或名称不存在，或者路径不正确。"
  },
  E0433: {
    chinese: "无法解析路径",
    explanation: "Rust 无法找到路径中的某个模块、类型或名称。"
  },
  E0499: {
    chinese: "同一个值不能同时被多次可变借用",
    explanation: "Rust 要求同一时间最多存在一个可变借用。"
  },
  E0500: {
    chinese: "闭包需要独占访问这个值",
    explanation: "闭包捕获变量时需要可变或独占访问，但当前代码仍有其他借用。"
  },
  E0501: {
    chinese: "可变借用仍然被闭包使用",
    explanation: "在闭包结束使用可变借用之前，不能再次访问或借用同一个值。"
  },
  E0502: {
    chinese: "可变借用和不可变借用发生冲突",
    explanation: "一个值已经存在不可变借用时，不能同时创建可变借用。"
  },
  E0505: {
    chinese: "值仍在被借用，不能移动它",
    explanation: "某个值存在有效借用时，不能把它 move 到别处。"
  },
  E0506: {
    chinese: "值仍在被借用，不能给它赋值",
    explanation: "借用结束前不能修改被借用的变量。"
  },
  E0507: {
    chinese: "不能从借用的内容中移动值",
    explanation: "借用只能读取或按规则修改值，不能直接把其中的非 Copy 值 move 出来。"
  },
  E0515: {
    chinese: "不能返回指向局部变量的引用",
    explanation: "函数返回后局部变量会被销毁，返回的引用会失效。"
  },
  E0521: {
    chinese: "借用的数据逃出了当前闭包或函数",
    explanation: "引用的生命周期不足以满足它被保存或返回后的使用范围。"
  },
  E0596: {
    chinese: "不能进行可变借用，因为变量没有声明为可变",
    explanation: "如果需要通过借用修改值，请先使用 let mut 声明变量。"
  },
  E0592: {
    chinese: "检测到重复定义",
    explanation: "同一个类型或 trait 中不能存在同名的关联项。"
  },
  E0593: {
    chinese: "闭包参数数量不正确",
    explanation: "闭包接收的参数数量与调用方要求的数量不同。"
  },
  E0597: {
    chinese: "借用的值活得不够久",
    explanation: "引用的生命周期超过了被引用值的生命周期。"
  },
  E0599: {
    chinese: "此类型上找不到这个方法或关联项",
    explanation: "请检查方法名、接收者类型以及是否引入了所需的 trait。"
  },
  E0609: {
    chinese: "此类型上找不到这个字段",
    explanation: "请检查字段名以及当前表达式的实际类型。"
  },
  E0614: {
    chinese: "这个类型不能被解引用",
    explanation: "只有实现了 Deref 或相关解引用规则的类型才能使用 * 运算符。"
  },
  E0616: {
    chinese: "这个字段是私有的，当前代码不能访问",
    explanation: "请通过公开的方法或关联函数访问它，或者调整可见性。"
  },
  E0624: {
    chinese: "这个方法是私有的，当前代码不能调用",
    explanation: "请检查方法的可见性，或使用公开的替代接口。"
  },
  E0631: {
    chinese: "闭包参数类型不匹配",
    explanation: "闭包的参数类型与使用它的函数或方法要求的类型不同。"
  },
  E0658: {
    chinese: "使用了尚未稳定的 Rust 特性",
    explanation: "这个特性目前只能在 nightly 工具链中使用，并且可能需要显式开启。"
  },
  E0689: {
    chinese: "数字类型不明确",
    explanation: "请给数字增加类型标注，例如 1_i32，或让上下文明确它的类型。"
  },
  E0716: {
    chinese: "临时值在借用结束前就被释放了",
    explanation: "可以先把临时值绑定到变量，再创建引用，延长它的生命周期。"
  },
  E0728: {
    chinese: "只能在 async 函数或 async 块中使用 await",
    explanation: "请把当前函数声明为 async，或把代码放入 async 块中。"
  },
  E0759: {
    chinese: "这个引用的生命周期不满足要求",
    explanation: "实际生命周期太短，不能满足目标位置要求的生命周期。"
  },
  E0782: {
    chinese: "trait 类型需要使用 dyn",
    explanation: "在需要 trait 对象的地方使用 dyn Trait 形式。"
  },
  E0793: {
    chinese: "对齐不正确的 packed 字段进行引用",
    explanation: "packed 结构体字段可能没有正确对齐，不能直接创建引用。"
  }
};

const MESSAGE_TRANSLATIONS: ReadonlyArray<{
  pattern: RegExp;
  chinese: string;
  explanation?: string;
}> = [
  {
    pattern: /cannot assign twice to immutable variable/i,
    chinese: "不能给不可变变量再次赋值",
    explanation: "使用 let 创建的变量默认不可修改。如果需要修改，请使用 let mut。"
  },
  {
    pattern: /mismatched types/i,
    chinese: "类型不匹配",
    explanation: "实际类型与当前位置期望的类型不同。"
  },
  {
    pattern: /cannot find (?:value|function|type|struct|module) .* in this scope/i,
    chinese: "当前作用域中找不到这个名称",
    explanation: "请检查拼写、作用域以及是否需要使用 use 引入。"
  },
  {
    pattern: /unused variable/i,
    chinese: "变量已声明但没有使用",
    explanation: "如果变量确实不需要使用，可以在名称前加下划线。"
  },
  {
    pattern: /unused import/i,
    chinese: "导入了但没有使用",
    explanation: "可以删除不需要的 use 语句，或在代码中使用导入的名称。"
  },
  {
    pattern: /variable does not need to be mutable|unused mut/i,
    chinese: "这个变量不需要声明为可变",
    explanation: "如果变量没有被修改，可以删除 mut。"
  },
  {
    pattern: /use of moved value/i,
    chinese: "使用了已经被移动的值",
    explanation: "值被 move 后，原变量通常不能再次使用。"
  },
  {
    pattern: /borrowed value does not live long enough/i,
    chinese: "借用的值活得不够久",
    explanation: "引用的生命周期超过了被引用值的生命周期。"
  },
  {
    pattern: /cannot move out of borrowed content/i,
    chinese: "不能从借用的内容中移动值",
    explanation: "借用期间不能直接把其中的非 Copy 值 move 出来。"
  },
  {
    pattern: /trait bound .* is not satisfied/i,
    chinese: "此类型不满足所需的 trait 约束",
    explanation: "当前类型没有实现代码要求的 trait。"
  },
  {
    pattern: /no method named .* found/i,
    chinese: "此类型上找不到这个方法",
    explanation: "请检查方法名、接收者类型以及是否引入了所需的 trait。"
  },
  {
    pattern: /expected .* found/i,
    chinese: "类型或结构不符合预期",
    explanation: "错误位置需要一种形式，但实际代码提供了另一种形式。"
  },
  {
    pattern: /expected (?:semicolon|';')/i,
    chinese: "这里需要一个分号",
    explanation: "Rust 语句通常需要使用分号结束。"
  }
];

/**
 * rustc 的 Diagnostic.code 既可能是字符串/数字，也可能是带 value 的对象。
 * 统一转换后，词典可以稳定地使用 E0384 这样的错误代码作为 key。
 */
export function getDiagnosticCode(diagnostic: vscode.Diagnostic): string | undefined {
  const rawCode = diagnostic.code;

  if (typeof rawCode === "string" || typeof rawCode === "number") {
    return String(rawCode).toUpperCase();
  }

  if (rawCode && typeof rawCode === "object" && "value" in rawCode) {
    const value = rawCode.value;
    if (typeof value === "string" || typeof value === "number") {
      return String(value).toUpperCase();
    }
  }

  return undefined;
}

export function translateDiagnostic(diagnostic: vscode.Diagnostic): DiagnosticTranslation {
  const code = getDiagnosticCode(diagnostic);
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
      matchedBy: "code"
    };
  }

  const message = diagnostic.message.replace(/\r?\n/g, " ").trim();
  const phrase = MESSAGE_TRANSLATIONS.find((item) => item.pattern.test(message));

  if (phrase) {
    return {
      chinese: phrase.chinese,
      explanation: phrase.explanation,
      matchedBy: "message"
    };
  }

  return {
    chinese: "暂无详细中文说明",
    explanation: "这是一条 Rust 诊断提示，当前词典还没有针对它的详细解释。",
    matchedBy: "fallback"
  };
}
