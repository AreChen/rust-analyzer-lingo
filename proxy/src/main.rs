use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

const REAL_SERVER_ENV: &str = "RUST_ANALYZER_LINGO_REAL_SERVER";
const LOCALE_ENV: &str = "RUST_ANALYZER_LINGO_LOCALE";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestKind {
    Diagnostic,
    Hover,
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(real_server) = find_real_server() else {
        eprintln!(
            "rust-analyzer-lingo: 找不到原始 rust-analyzer，请设置 {} 环境变量。",
            REAL_SERVER_ENV
        );
        std::process::exit(1);
    };
    debug_log(&format!("使用原始服务器：{}", real_server.display()));

    // rust-analyzer 扩展会先调用可执行文件的 --version 来检查服务器。
    // 这类调用不是 LSP，不应经过 JSON-RPC 转发。
    if args.iter().any(|arg| arg == "--version" || arg == "--help") {
        let status = Command::new(real_server).args(args).status();
        match status {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(error) => {
                eprintln!("rust-analyzer-lingo: 无法启动原始 rust-analyzer：{}", error);
                std::process::exit(1);
            }
        }
    }

    if let Err(error) = run_lsp_proxy(&real_server, &args) {
        eprintln!("rust-analyzer-lingo: LSP 代理运行失败：{}", error);
        std::process::exit(1);
    }
}

fn run_lsp_proxy(real_server: &Path, args: &[String]) -> io::Result<()> {
    let mut child = Command::new(real_server)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;

    let server_stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "原始服务器没有 stdin"))?;
    let server_stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "原始服务器没有 stdout"))?;

    let pending_requests = Arc::new(Mutex::new(HashMap::<String, RequestKind>::new()));
    let catalog = Arc::new(load_catalog());

    let requests_to_server = Arc::clone(&pending_requests);
    let client_to_server = thread::spawn(move || -> io::Result<()> {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        let mut writer = BufWriter::new(server_stdin);

        while let Some(body) = read_lsp_message(&mut reader)? {
            debug_log(&format!("客户端 -> 服务器：{} 字节", body.len()));
            let body = track_request(body, &requests_to_server);
            write_lsp_message(&mut writer, &body)?;
            writer.flush()?;
        }

        Ok(())
    });

    let requests_from_server = Arc::clone(&pending_requests);
    let catalog_from_server = Arc::clone(&catalog);
    let server_to_client = thread::spawn(move || -> io::Result<()> {
        let mut reader = BufReader::new(server_stdout);
        let stdout = io::stdout();
        let mut writer = BufWriter::new(stdout.lock());

        while let Some(body) = read_lsp_message(&mut reader)? {
            debug_log(&format!("服务器 -> 客户端：{} 字节", body.len()));
            let mut message: Value = match serde_json::from_slice(&body) {
                Ok(message) => message,
                Err(_) => {
                    // 非 JSON 消息不应出现在 LSP stdout，但为了保持代理透明，
                    // 解析失败时仍然原样转发。
                    write_lsp_message(&mut writer, &body)?;
                    writer.flush()?;
                    continue;
                }
            };

            translate_server_message(&mut message, &requests_from_server, &catalog_from_server);

            let translated = serde_json::to_vec(&message).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("序列化 LSP 消息失败：{}", error),
                )
            })?;
            write_lsp_message(&mut writer, &translated)?;
            writer.flush()?;
        }

        Ok(())
    });

    let status = child.wait()?;
    let _ = client_to_server.join();
    let _ = server_to_client.join();

    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Other,
            format!("原始服务器退出，状态码：{}", status),
        ))
    }
}

fn read_lsp_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut content_length = None;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            return Ok(None);
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }

        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(value.trim().parse::<usize>().map_err(|error| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("无效的 Content-Length：{}", error),
                    )
                })?);
            }
        }
    }

    let content_length = content_length
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "LSP 消息缺少 Content-Length"))?;
    let mut body = vec![0_u8; content_length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

fn write_lsp_message<W: Write>(writer: &mut W, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)
}

fn track_request(body: Vec<u8>, requests: &Arc<Mutex<HashMap<String, RequestKind>>>) -> Vec<u8> {
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return body;
    };

    let request_kind =
        message
            .get("method")
            .and_then(Value::as_str)
            .and_then(|method| match method {
                "textDocument/diagnostic" | "workspace/diagnostic" => Some(RequestKind::Diagnostic),
                "textDocument/hover" => Some(RequestKind::Hover),
                _ => None,
            });

    if let (Some(request_kind), Some(id)) = (request_kind, message.get("id")) {
        if let Ok(mut requests) = requests.lock() {
            requests.insert(id_key(id), request_kind);
        }
    }

    body
}

fn translate_server_message(
    message: &mut Value,
    pending_requests: &Arc<Mutex<HashMap<String, RequestKind>>>,
    catalog: &HashMap<String, String>,
) {
    if message
        .get("method")
        .and_then(Value::as_str)
        .is_some_and(|method| method == "textDocument/publishDiagnostics")
    {
        if let Some(diagnostics) = message
            .get_mut("params")
            .and_then(Value::as_object_mut)
            .and_then(|params| params.get_mut("diagnostics"))
            .and_then(Value::as_array_mut)
        {
            translate_diagnostics(diagnostics, catalog);
        }
    }

    let request_kind = if message.get("method").is_none() {
        message.get("id").map(id_key).and_then(|id| {
            pending_requests
                .lock()
                .ok()
                .and_then(|mut requests| requests.remove(&id))
        })
    } else {
        None
    };

    if let Some(result) = message.get_mut("result") {
        match request_kind {
            Some(RequestKind::Diagnostic) => translate_diagnostic_result(result, catalog),
            Some(RequestKind::Hover) => translate_hover_result(result),
            None => {}
        }
    }
}

fn translate_diagnostic_result(result: &mut Value, catalog: &HashMap<String, String>) {
    match result {
        Value::Object(object) => {
            if let Some(items) = object.get_mut("items").and_then(Value::as_array_mut) {
                translate_diagnostics(items, catalog);
            }

            for (key, value) in object.iter_mut() {
                if key == "items" {
                    continue;
                }

                if value.get("range").is_some() && value.get("message").is_some() {
                    translate_diagnostic(value, catalog);
                } else if value.is_object() {
                    translate_diagnostic_result(value, catalog);
                }
            }
        }
        Value::Array(values) => {
            translate_diagnostics(values, catalog);
        }
        _ => {}
    }
}

fn translate_hover_result(result: &mut Value) {
    if let Some(contents) = result.get_mut("contents") {
        translate_hover_contents(contents);
    }
}

fn translate_hover_contents(contents: &mut Value) {
    match contents {
        Value::String(text) => *text = translate_hover_text(text),
        Value::Array(items) => {
            for item in items {
                translate_hover_contents(item);
            }
        }
        Value::Object(object) => {
            if let Some(value) = object.get_mut("value") {
                translate_hover_contents(value);
            }
        }
        _ => {}
    }
}

fn translate_hover_text(text: &str) -> String {
    text.replace("value of literal: ", "字面量的值：")
        .replace("value of literal:", "字面量的值：")
        .replace(
            "invalid literal: MoreThanOneChar",
            "无效的字符字面量：包含多个字符",
        )
}

fn translate_diagnostics(diagnostics: &mut Vec<Value>, catalog: &HashMap<String, String>) {
    let mut seen = HashSet::new();

    diagnostics.retain_mut(|diagnostic| {
        if is_diagnostic(diagnostic) {
            translate_diagnostic(diagnostic, catalog);
            return diagnostic_key(diagnostic)
                .map(|key| seen.insert(key))
                .unwrap_or(true);
        }

        translate_diagnostic_result(diagnostic, catalog);
        true
    });
}

fn diagnostic_key(diagnostic: &Value) -> Option<String> {
    let object = diagnostic.as_object()?;
    serde_json::to_string(&(
        object.get("range")?,
        object.get("message")?,
        object.get("code"),
        object.get("severity"),
    ))
    .ok()
}

fn is_diagnostic(value: &Value) -> bool {
    value.get("range").is_some() && value.get("message").and_then(Value::as_str).is_some()
}

fn translate_diagnostic(diagnostic: &mut Value, catalog: &HashMap<String, String>) {
    let original_message = diagnostic
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let rendered = diagnostic
        .pointer("/data/rendered")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let code = diagnostic.get("code").and_then(normalize_code);

    let chinese = code
        .as_deref()
        .and_then(common_title)
        .map(str::to_owned)
        .or_else(|| code.as_deref().and_then(|code| catalog.get(code).cloned()))
        .or_else(|| translate_message_with_context(&original_message, rendered.as_deref()))
        .or_else(|| {
            code.as_deref()
                .map(|code| format!("Rust 编译诊断 `{}`", code))
        })
        .unwrap_or_else(|| "Rust 诊断提示".to_owned());

    let translated_message = if let Some(explanation) = code.as_deref().and_then(common_explanation)
    {
        format!("{}。{}", chinese.trim_end_matches('。'), explanation)
    } else {
        chinese
    };

    if let Some(object) = diagnostic.as_object_mut() {
        object.insert("message".to_owned(), Value::String(translated_message));
        // 让原生 Hover 的来源标签也保持中文；同时移除 VS Code 根据
        // codeDescription 自动追加的英文“Click for full compiler diagnostic”链接。
        object.insert(
            "source".to_owned(),
            Value::String(diagnostic_source_label().to_owned()),
        );
        object.remove("codeDescription");

        if let Some(translated_rendered) = rendered
            .as_deref()
            .and_then(|rendered| translate_rendered_diagnostic(&original_message, rendered))
        {
            if let Some(data) = object.get_mut("data").and_then(Value::as_object_mut) {
                data.insert("rendered".to_owned(), Value::String(translated_rendered));
            }
        }

        if let Some(related_information) = object
            .get_mut("relatedInformation")
            .and_then(Value::as_array_mut)
        {
            related_information.retain_mut(|related| {
                let Some(related_object) = related.as_object_mut() else {
                    return false;
                };

                // VS Code renders relatedInformation as additional lines in the
                // native diagnostic hover. Remove metadata that merely repeats
                // the primary diagnostic, but keep actionable compiler notes.
                related_object.remove("codeDescription");

                let Some(related_message) = related_object
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    return false;
                };

                if is_redundant_related_message(&related_message, &original_message) {
                    return false;
                }

                related_object.insert(
                    "message".to_owned(),
                    Value::String(translate_related_message(&related_message)),
                );
                true
            });
        }
    }
}

fn is_redundant_related_message(message: &str, original_message: &str) -> bool {
    let trimmed = message.trim();
    let lower = trimmed.to_ascii_lowercase();

    trimmed.is_empty()
        || trimmed == original_message.trim()
        || lower == "original diagnostic"
        || lower.contains("click for full compiler diagnostic")
        || translate_related_message(trimmed) == "Rust 相关诊断提示"
}

fn normalize_code(value: &Value) -> Option<String> {
    let raw = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Object(object) => object.get("value").and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })?,
        _ => return None,
    };

    let upper = raw.to_uppercase();
    let bytes = upper.as_bytes();
    for index in 0..bytes.len().saturating_sub(4) {
        if bytes[index] == b'E' && bytes[index + 1..index + 5].iter().all(u8::is_ascii_digit) {
            return Some(upper[index..index + 5].to_owned());
        }
    }

    let raw = raw.trim();
    if !raw.is_empty()
        && raw
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Some(raw.to_ascii_lowercase());
    }

    None
}

fn common_title(code: &str) -> Option<&'static str> {
    match code {
        "E0384" => Some("不能给不可变变量再次赋值"),
        "E0277" => Some("此类型不满足所需的 trait 约束"),
        "E0308" => Some("类型不匹配"),
        "E0502" => Some("可变借用和不可变借用发生冲突"),
        "E0596" => Some("不能进行可变借用，因为变量没有声明为可变"),
        _ => None,
    }
}

fn common_explanation(code: &str) -> Option<&'static str> {
    match code {
        "E0384" => Some("使用 let 创建的变量默认不可修改；如果需要修改，请使用 let mut"),
        "E0277" => Some("当前类型没有实现代码要求的 trait"),
        "E0308" => Some("表达式实际产生的类型与当前位置期望的类型不同"),
        "E0502" => Some("一个值已经存在不可变借用时，不能同时创建可变借用"),
        "E0596" => Some("如果需要通过借用修改值，请先使用 let mut 声明变量"),
        _ => None,
    }
}

#[derive(Debug, Eq, PartialEq)]
struct LiteralOverflowDetails {
    target_type: String,
    literal: Option<String>,
    range: Option<String>,
    suggested_type: Option<String>,
}

fn translate_message_with_context(message: &str, rendered: Option<&str>) -> Option<String> {
    if let Some(details) = parse_literal_overflow(message, rendered) {
        return Some(literal_overflow_summary(&details));
    }

    translate_message(message)
}

fn parse_literal_overflow(message: &str, rendered: Option<&str>) -> Option<LiteralOverflowDetails> {
    if !message
        .to_ascii_lowercase()
        .contains("literal out of range for")
    {
        return None;
    }

    let target_type = backticked_value_after(message, "literal out of range for")?;
    let rendered = rendered.map(strip_ansi_sequences).unwrap_or_default();

    Some(LiteralOverflowDetails {
        target_type,
        literal: backticked_value_after(&rendered, "the literal"),
        range: backticked_value_after(&rendered, "whose range is"),
        suggested_type: backticked_value_after(&rendered, "consider using the type"),
    })
}

fn literal_overflow_summary(details: &LiteralOverflowDetails) -> String {
    let subject = details
        .literal
        .as_deref()
        .map(|literal| format!("整数字面量 `{}`", literal))
        .unwrap_or_else(|| "整数字面量".to_owned());
    let mut summary = format!("{} 超出了 `{}` 的取值范围", subject, details.target_type);

    if let Some(range) = details.range.as_deref() {
        summary.push_str(&format!(" `{}`", range));
    }
    if let Some(suggested_type) = details.suggested_type.as_deref() {
        summary.push_str(&format!("；建议改用 `{}`", suggested_type));
    }

    summary
}

fn translate_rendered_diagnostic(message: &str, rendered: &str) -> Option<String> {
    let details = parse_literal_overflow(message, Some(rendered))?;
    let rendered = strip_ansi_sequences(rendered);
    let title = format!("整数字面量超出了 `{}` 的取值范围", details.target_type);
    let note = match (details.literal.as_deref(), details.range.as_deref()) {
        (Some(literal), Some(range)) => format!(
            "字面量 `{}` 无法存入类型 `{}`，该类型的范围是 `{}`",
            literal, details.target_type, range
        ),
        (Some(literal), None) => format!(
            "字面量 `{}` 无法存入类型 `{}`",
            literal, details.target_type
        ),
        _ => title.clone(),
    };

    let mut translated_lines = Vec::new();
    for line in rendered.lines() {
        let trimmed = line.trim_start();
        let indent = &line[..line.len() - trimmed.len()];
        let lower = trimmed.to_ascii_lowercase();

        let translated = if lower.contains("error: literal out of range for") {
            format!("{}错误：{}", indent, title)
        } else if lower.contains("= note: the literal") && lower.contains("does not fit") {
            format!("{}= 说明：{}", indent, note)
        } else if lower.contains("= help: consider using the type") {
            let suggestion = details
                .suggested_type
                .as_deref()
                .map(|value| format!("改用类型 `{}`", value))
                .unwrap_or_else(|| "改用范围更大的整数类型".to_owned());
            format!("{}= 建议：{}", indent, suggestion)
        } else if lower.contains("= note: `#[deny(overflowing_literals)]` on by default") {
            format!(
                "{}= 说明：默认启用了 `#[deny(overflowing_literals)]`",
                indent
            )
        } else {
            line.to_owned()
        };

        translated_lines.push(translated);
    }

    let mut translated = translated_lines.join("\n");
    if rendered.ends_with('\n') {
        translated.push('\n');
    }
    Some(translated)
}

fn backticked_value_after(text: &str, marker: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let marker = marker.to_ascii_lowercase();
    let marker_end = lower.find(&marker)? + marker.len();
    let remainder = &text[marker_end..];
    let value_start = remainder.find('`')? + 1;
    let value = &remainder[value_start..];
    let value_end = value.find('`')?;
    Some(value[..value_end].to_owned())
}

fn strip_ansi_sequences(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut stripped = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'[') {
            index += 2;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
        } else {
            stripped.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8_lossy(&stripped).into_owned()
}

fn translate_message(message: &str) -> Option<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return None;
    }

    if contains_chinese(trimmed) {
        return Some(trimmed.to_owned());
    }

    let lower = trimmed.to_lowercase();
    if lower.contains("syntax error") && lower.contains("semicolon") {
        return Some("语法错误：这里需要一个分号".to_owned());
    }
    if lower.contains("cannot mutate immutable variable")
        || lower.contains("cannot assign twice to immutable variable")
    {
        return Some("不能给不可变变量再次赋值".to_owned());
    }
    if lower.contains("mismatched types") {
        return Some("类型不匹配".to_owned());
    }
    if lower.contains("unexpected token") {
        return Some("出现了意外的标记".to_owned());
    }
    if lower.contains("expected") && lower.contains("found") {
        return Some(translate_expected_found(trimmed));
    }
    if lower.contains("morethanonechar")
        || lower.contains("character literal may only contain one codepoint")
    {
        return Some(
            "字符字面量只能包含一个字符；如果要表示多个字符，请使用字符串字面量，例如 \"a2\""
                .to_owned(),
        );
    }
    if lower.contains("unused variable") {
        return Some("变量已声明但没有使用".to_owned());
    }
    if lower.contains("unused import") {
        return Some("导入了但没有使用".to_owned());
    }
    if lower.contains("use of moved value") {
        return Some("使用了已经被移动的值".to_owned());
    }
    if lower.contains("borrowed value does not live long enough") {
        return Some("借用的值活得不够久".to_owned());
    }
    if lower.contains("no method named") {
        return Some("此类型上找不到这个方法".to_owned());
    }
    if lower.contains("cannot find") && lower.contains("in this scope") {
        return Some("当前作用域中找不到这个名称".to_owned());
    }

    None
}

fn translate_related_message(message: &str) -> String {
    let trimmed = message.trim();
    let lower = trimmed.to_lowercase();

    if lower == "original diagnostic" {
        return "原始诊断".to_owned();
    }
    if lower.starts_with("add ") && lower.contains(" here:") {
        let suggestion = trimmed[4..]
            .split_once(" here:")
            .map(|(suggestion, _)| suggestion.trim())
            .unwrap_or_default();
        return format!("建议在这里添加：{}", suggestion);
    }
    if lower.contains("unexpected token") {
        return "出现了意外的标记".to_owned();
    }
    if lower.contains("expected") && lower.contains("found") {
        return translate_expected_found(trimmed);
    }
    if lower.contains("morethanonechar")
        || lower.contains("character literal may only contain one codepoint")
    {
        return "字符字面量只能包含一个字符".to_owned();
    }
    if let Some(translated) = translate_message_with_context(trimmed, None) {
        return translated;
    }

    // 相关信息没有独立的错误代码。未知内容使用中文占位，避免原生 Hover
    // 再次把整段英文直接展示给用户。
    "Rust 相关诊断提示".to_owned()
}

fn translate_expected_found(message: &str) -> String {
    let lower = message.to_lowercase();
    let Some(expected_start) = lower.find("expected ") else {
        return "代码形式不符合预期".to_owned();
    };
    let value_start = expected_start + "expected ".len();
    let Some(found_marker) = lower[value_start..].find(", found ") else {
        return "代码形式不符合预期".to_owned();
    };
    let found_start = value_start + found_marker + ", found ".len();
    let expected = message[value_start..value_start + found_marker].trim();
    let found = message[found_start..].trim();
    format!("这里需要 {}，但实际找到 {}", expected, found)
}

fn contains_chinese(value: &str) -> bool {
    value
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
}

fn diagnostic_source_label() -> &'static str {
    localized_source_label(&active_locale())
}

fn active_locale() -> String {
    if let Ok(locale) = env::var(LOCALE_ENV) {
        if !locale.trim().is_empty() {
            return locale;
        }
    }

    if let Ok(nls_config) = env::var("VSCODE_NLS_CONFIG") {
        if let Ok(config) = serde_json::from_str::<Value>(&nls_config) {
            if let Some(locale) = config
                .get("locale")
                .or_else(|| config.get("osLocale"))
                .and_then(Value::as_str)
            {
                return locale.to_owned();
            }
        }
    }

    env::var("LANG").unwrap_or_else(|_| "en".to_owned())
}

fn localized_source_label(locale: &str) -> &'static str {
    let locale = locale.trim().to_ascii_lowercase().replace('_', "-");

    if locale.starts_with("zh-tw")
        || locale.starts_with("zh-hk")
        || locale.starts_with("zh-mo")
        || locale.starts_with("zh-hant")
    {
        return "Rust 中文診斷";
    }
    if locale.starts_with("zh") {
        return "Rust 中文诊断";
    }
    if locale.starts_with("ja") {
        return "Rust 診断";
    }
    if locale.starts_with("ko") {
        return "Rust 진단";
    }
    if locale.starts_with("de") {
        return "Rust-Diagnose";
    }
    if locale.starts_with("fr") {
        return "Diagnostics Rust";
    }
    if locale.starts_with("es") {
        return "Diagnósticos de Rust";
    }
    if locale.starts_with("pt") {
        return "Diagnósticos do Rust";
    }
    if locale.starts_with("ru") {
        return "Диагностика Rust";
    }

    "Rust Diagnostics"
}

fn load_catalog() -> HashMap<String, String> {
    let Some(extension_root) = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .and_then(|path| path.parent().map(Path::to_path_buf))
    else {
        return HashMap::new();
    };

    let catalog_path = extension_root.join("dist").join("error-codes.js");
    let Ok(source) = fs::read_to_string(catalog_path) else {
        return HashMap::new();
    };

    let mut catalog = HashMap::new();
    for line in source.lines() {
        let line = line.trim();
        if !line.starts_with('E')
            || !line
                .as_bytes()
                .get(1..5)
                .is_some_and(|digits| digits.iter().all(u8::is_ascii_digit))
        {
            continue;
        }

        let Some(colon) = line.find(':') else {
            continue;
        };
        let code = line[..colon].trim();
        let Some(first_quote) = line[colon + 1..].find('"') else {
            continue;
        };
        let first_quote = colon + 1 + first_quote;
        let Some(last_quote) = line[first_quote + 1..].rfind('"') else {
            continue;
        };
        let last_quote = first_quote + 1 + last_quote;
        let json_string = &line[first_quote..=last_quote];
        if let Ok(title) = serde_json::from_str::<String>(json_string) {
            catalog.insert(code.to_owned(), title);
        }
    }

    catalog
}

fn find_real_server() -> Option<PathBuf> {
    if let Ok(path) = env::var(REAL_SERVER_ENV) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    for extensions_root in vscode_extensions_roots() {
        let Ok(entries) = fs::read_dir(extensions_root) else {
            continue;
        };

        let mut candidates = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("rust-lang.rust-analyzer-") {
                continue;
            }

            let server_name = if cfg!(windows) {
                "rust-analyzer.exe"
            } else {
                "rust-analyzer"
            };
            let server = entry.path().join("server").join(server_name);
            if server.is_file() {
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok();
                candidates.push((modified, server));
            }
        }

        candidates.sort_by(|left, right| right.0.cmp(&left.0));
        if let Some((_, server)) = candidates.into_iter().next() {
            return Some(server);
        }
    }

    // 允许用户直接把 rust-analyzer 放在 PATH 中。
    Some(PathBuf::from(if cfg!(windows) {
        "rust-analyzer.exe"
    } else {
        "rust-analyzer"
    }))
}

fn vscode_extensions_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let user_root = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from);

    if let Some(user_root) = user_root {
        roots.push(user_root.join(".vscode").join("extensions"));
        roots.push(user_root.join(".vscode-insiders").join("extensions"));
    }

    roots
}

fn id_key(value: &Value) -> String {
    value.to_string()
}

fn debug_log(message: &str) {
    if env::var_os("RUST_ANALYZER_LINGO_DEBUG").is_some() {
        eprintln!("rust-analyzer-lingo: {}", message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn translates_overflowing_literal_with_rendered_context() {
        let mut diagnostic = json!({
            "range": {
                "start": { "line": 61, "character": 46 },
                "end": { "line": 61, "character": 51 }
            },
            "severity": 1,
            "code": "overflowing_literals",
            "codeDescription": { "href": "https://example.invalid" },
            "source": "rustc",
            "message": "literal out of range for `i8`",
            "data": {
                "rendered": concat!(
                    "\u{1b}[1merror\u{1b}[0m: literal out of range for `i8`\n",
                    "  --> src\\main.rs:62:47\n",
                    "   |\n",
                    "62 |     let value: i8 = 12329;\n",
                    "   |                     ^^^^^\n",
                    "   |\n",
                    "   = note: the literal `12329` does not fit into the type `i8` whose range is `-128..=127`\n",
                    "   = help: consider using the type `i16` instead\n",
                    "   = note: `#[deny(overflowing_literals)]` on by default\n"
                )
            }
        });

        translate_diagnostic(&mut diagnostic, &HashMap::new());

        assert_eq!(
            diagnostic["message"],
            "整数字面量 `12329` 超出了 `i8` 的取值范围 `-128..=127`；建议改用 `i16`"
        );
        assert_eq!(diagnostic["source"], diagnostic_source_label());
        assert_eq!(diagnostic["code"], "overflowing_literals");
        assert!(diagnostic.get("codeDescription").is_none());

        let rendered = diagnostic["data"]["rendered"].as_str().unwrap();
        assert!(rendered.contains("错误：整数字面量超出了 `i8` 的取值范围"));
        assert!(rendered.contains("说明：字面量 `12329` 无法存入类型 `i8`"));
        assert!(rendered.contains("建议：改用类型 `i16`"));
        assert!(!rendered.contains("literal out of range"));
        assert!(!rendered.contains('\u{1b}'));
    }

    #[test]
    fn tracks_and_translates_literal_hover_responses() {
        let requests = Arc::new(Mutex::new(HashMap::new()));
        let request = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "textDocument/hover",
            "params": {}
        }))
        .unwrap();
        track_request(request, &requests);

        let mut response = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "result": {
                "contents": {
                    "kind": "markdown",
                    "value": "```rust\ni8\n```\n\nvalue of literal: 12329 (0x3029|0b11000000101001)"
                }
            }
        });
        translate_server_message(&mut response, &requests, &HashMap::new());

        assert_eq!(
            response["result"]["contents"]["value"],
            "```rust\ni8\n```\n\n字面量的值：12329 (0x3029|0b11000000101001)"
        );
        assert!(requests.lock().unwrap().is_empty());
    }

    #[test]
    fn preserves_named_rustc_lint_codes() {
        assert_eq!(
            normalize_code(&json!("overflowing_literals")),
            Some("overflowing_literals".to_owned())
        );
        assert_eq!(
            normalize_code(&json!("rustc(E0308)")),
            Some("E0308".to_owned())
        );
    }

    #[test]
    fn localizes_diagnostic_source_labels() {
        assert_eq!(localized_source_label("zh-cn"), "Rust 中文诊断");
        assert_eq!(localized_source_label("zh-Hant"), "Rust 中文診斷");
        assert_eq!(localized_source_label("ja"), "Rust 診断");
        assert_eq!(localized_source_label("de-DE"), "Rust-Diagnose");
        assert_eq!(localized_source_label("en-US"), "Rust Diagnostics");
        assert_eq!(localized_source_label("unknown"), "Rust Diagnostics");
    }
}
