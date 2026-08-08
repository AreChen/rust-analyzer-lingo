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

    let diagnostic_requests = Arc::new(Mutex::new(HashSet::<String>::new()));
    let catalog = Arc::new(load_catalog());

    let requests_to_server = Arc::clone(&diagnostic_requests);
    let client_to_server = thread::spawn(move || -> io::Result<()> {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        let mut writer = BufWriter::new(server_stdin);

        while let Some(body) = read_lsp_message(&mut reader)? {
            debug_log(&format!("客户端 -> 服务器：{} 字节", body.len()));
            let body = track_diagnostic_request(body, &requests_to_server);
            write_lsp_message(&mut writer, &body)?;
            writer.flush()?;
        }

        Ok(())
    });

    let requests_from_server = Arc::clone(&diagnostic_requests);
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

            translate_server_message(
                &mut message,
                &requests_from_server,
                &catalog_from_server,
            );

            let translated = serde_json::to_vec(&message).map_err(|error| {
                io::Error::new(io::ErrorKind::InvalidData, format!("序列化 LSP 消息失败：{}", error))
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
                    io::Error::new(io::ErrorKind::InvalidData, format!("无效的 Content-Length：{}", error))
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

fn track_diagnostic_request(
    body: Vec<u8>,
    requests: &Arc<Mutex<HashSet<String>>>,
) -> Vec<u8> {
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return body;
    };

    let is_diagnostic_request = message
        .get("method")
        .and_then(Value::as_str)
        .map(|method| {
            method == "textDocument/diagnostic" || method == "workspace/diagnostic"
        })
        .unwrap_or(false);

    if is_diagnostic_request {
        if let Some(id) = message.get("id") {
            if let Ok(mut requests) = requests.lock() {
                requests.insert(id_key(id));
            }
        }
    }

    body
}

fn translate_server_message(
    message: &mut Value,
    diagnostic_requests: &Arc<Mutex<HashSet<String>>>,
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
            for diagnostic in diagnostics {
                translate_diagnostic(diagnostic, catalog);
            }
        }
    }

    let request_id = message.get("id").map(id_key);
    let is_diagnostic_response = request_id
        .as_ref()
        .and_then(|id| diagnostic_requests.lock().ok().map(|requests| requests.contains(id)))
        .unwrap_or(false);

    if is_diagnostic_response {
        if let Some(id) = request_id {
            if let Ok(mut requests) = diagnostic_requests.lock() {
                requests.remove(&id);
            }
        }

        if let Some(result) = message.get_mut("result") {
            translate_diagnostic_result(result, catalog);
        }
    }
}

fn translate_diagnostic_result(result: &mut Value, catalog: &HashMap<String, String>) {
    match result {
        Value::Object(object) => {
            if let Some(items) = object.get_mut("items").and_then(Value::as_array_mut) {
                for item in items {
                    if is_diagnostic(item) {
                        translate_diagnostic(item, catalog);
                    } else {
                        translate_diagnostic_result(item, catalog);
                    }
                }
            }

            for value in object.values_mut() {
                if value.get("range").is_some() && value.get("message").is_some() {
                    translate_diagnostic(value, catalog);
                } else if value.is_object() {
                    translate_diagnostic_result(value, catalog);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                translate_diagnostic_result(value, catalog);
            }
        }
        _ => {}
    }
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
    let code = diagnostic.get("code").and_then(normalize_code);

    let chinese = code
        .as_deref()
        .and_then(common_title)
        .map(str::to_owned)
        .or_else(|| code.as_deref().and_then(|code| catalog.get(code).cloned()))
        .or_else(|| code.as_deref().map(|code| format!("Rust 编译错误 {}", code)))
        .or_else(|| translate_message(&original_message))
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
            Value::String("Rust 中文诊断".to_owned()),
        );
        object.remove("codeDescription");

        if let Some(related_information) = object
            .get_mut("relatedInformation")
            .and_then(Value::as_array_mut)
        {
            for related in related_information {
                let translated = related
                    .get("message")
                    .and_then(Value::as_str)
                    .map(translate_related_message);
                if let Some(translated) = translated {
                    related["message"] = Value::String(translated);
                }
            }
        }
    }
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
    if let Some(translated) = translate_message(trimmed) {
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
    value.chars().any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
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
        if !line.starts_with('E') || !line.as_bytes().get(1..5).is_some_and(|digits| {
            digits.iter().all(u8::is_ascii_digit)
        }) {
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
