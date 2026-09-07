mod overflow;
use overflow::{literal_overflow_summary, parse_literal_overflow};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const REAL_SERVER_ENV: &str = "RUST_ANALYZER_LINGO_REAL_SERVER";
const MAX_BODY: usize = 64 * 1024 * 1024;
type Catalog = HashMap<String, Value>;
#[derive(Default)]
struct Pending {
    requests: HashMap<String, Option<String>>,
    progress: HashMap<String, usize>,
}
fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // Some official-client version queries do not pass server.extraEnv.
    if env::var_os(REAL_SERVER_ENV).is_none() && args.iter().any(|arg| arg == "--version") {
        println!(
            "rust-analyzer-lingo-proxy {} (server selected per workspace)",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    let result = find_real_server().and_then(|server| {
        if args.iter().any(|arg| arg == "--version" || arg == "--help") {
            let status = Command::new(server).args(args).status()?;
            std::process::exit(status.code().unwrap_or(1));
        }
        run_lsp_proxy(&server, &args)
    });
    if let Err(error) = result {
        eprintln!("rust-analyzer-lingo: {}", error);
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
        .ok_or_else(|| io::Error::other("服务器没有 stdin"))?;
    let server_stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("服务器没有 stdout"))?;
    let pending = Arc::new(Mutex::new(Pending::default()));
    let catalog = load_catalog();
    let (tx, rx) = mpsc::channel();
    let request_pending = Arc::clone(&pending);
    let input_tx = tx.clone();
    thread::spawn(move || {
        let result = (|| -> io::Result<()> {
            let stdin = io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            let mut writer = BufWriter::new(server_stdin);
            while let Some(body) = read_lsp_message(&mut reader)? {
                track_request(&body, &request_pending);
                write_lsp_message(&mut writer, &body)?;
                writer.flush()?;
            }
            Ok(())
        })();
        let _ = input_tx.send((false, result));
    });
    thread::spawn(move || {
        let result = (|| -> io::Result<()> {
            let mut reader = BufReader::new(server_stdout);
            let stdout = io::stdout();
            let mut writer = BufWriter::new(stdout.lock());
            while let Some(body) = read_lsp_message(&mut reader)? {
                let translated = transform_body(&body, &pending, &catalog);
                write_lsp_message(&mut writer, translated.as_deref().unwrap_or(&body))?;
                writer.flush()?;
            }
            Ok(())
        })();
        let _ = tx.send((true, result));
    });
    let mut output_done = false;
    let mut deadline = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(25)) {
            Ok((output, result)) => {
                if let Err(error) = result {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
                output_done |= output;
                deadline.get_or_insert(Instant::now() + Duration::from_secs(2));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                deadline.get_or_insert(Instant::now() + Duration::from_secs(2));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Some(status) = child.try_wait()? {
            // Drain final server messages, but never join the thread blocked on client stdin.
            if output_done {
                return if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other(format!(
                        "原始 rust-analyzer 已退出：{status}"
                    )))
                };
            }
            deadline.get_or_insert(Instant::now() + Duration::from_secs(2));
        }
        if deadline.is_some_and(|end| Instant::now() >= end) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "连接关闭后服务器未及时结束，已清理服务器进程",
            ));
        }
    }
}
fn read_lsp_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length = None;
    let mut headers = 0;
    loop {
        let mut line = String::new();
        let n = reader.take(8193).read_line(&mut line)?;
        if n == 0 {
            return if headers == 0 {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "不完整的 LSP 消息头",
                ))
            };
        }
        headers += n;
        if headers > 8192 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "LSP 消息头过长"));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                if length.is_some() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "重复的 Content-Length",
                    ));
                }
                length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
                );
            }
        }
    }
    let length = length.filter(|n| *n <= MAX_BODY).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Content-Length 缺失或超过 64 MiB",
        )
    })?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}
fn write_lsp_message<W: Write>(writer: &mut W, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)
}
fn track_request(body: &[u8], pending: &Arc<Mutex<Pending>>) {
    let Ok(message) = serde_json::from_slice::<Value>(body) else {
        return;
    };
    if !matches!(
        message.get("method").and_then(Value::as_str),
        Some("textDocument/diagnostic" | "workspace/diagnostic")
    ) {
        return;
    }
    if let Some(id) = message.get("id") {
        let token = message
            .pointer("/params/partialResultToken")
            .map(Value::to_string);
        let mut pending = pending.lock().unwrap();
        if let Some(token) = &token {
            *pending.progress.entry(token.clone()).or_default() += 1;
        }
        pending.requests.insert(id.to_string(), token);
    }
}
fn transform_body(
    body: &[u8],
    pending: &Arc<Mutex<Pending>>,
    catalog: &Catalog,
) -> Option<Vec<u8>> {
    let mut message = serde_json::from_slice::<Value>(body).ok()?;
    let method = message.get("method").and_then(Value::as_str);
    let is_publish = method == Some("textDocument/publishDiagnostics");
    let is_progress = method == Some("$/progress")
        && message.pointer("/params/token").is_some_and(|token| {
            pending
                .lock()
                .unwrap()
                .progress
                .contains_key(&token.to_string())
        });
    let is_response = if method.is_none() {
        message.get("id").is_some_and(|id| {
            let mut pending = pending.lock().unwrap();
            if let Some(token) = pending.requests.remove(&id.to_string()) {
                if let Some(token) = token {
                    if let Some(count) = pending.progress.get_mut(&token) {
                        *count -= 1;
                        if *count == 0 {
                            pending.progress.remove(&token);
                        }
                    }
                }
                true
            } else {
                false
            }
        })
    } else {
        false
    };
    let value = if is_publish {
        message.pointer_mut("/params/diagnostics")
    } else if is_progress {
        message.pointer_mut("/params/value")
    } else if is_response {
        message.get_mut("result")
    } else {
        None
    }?;
    let before = value.clone();
    translate_report(value, catalog);
    if *value == before {
        None
    } else {
        serde_json::to_vec(&message).ok()
    }
}
fn translate_report(value: &mut Value, catalog: &Catalog) {
    match value {
        Value::Array(values) => {
            for value in values {
                translate_report(value, catalog);
            }
        }
        Value::Object(object)
            if object.get("range").is_some()
                && object.get("message").is_some_and(Value::is_string) =>
        {
            translate_diagnostic(value, catalog)
        }
        Value::Object(object) => {
            // Only traverse protocol-defined report fields, never diagnostic data or arbitrary extension fields.
            for key in ["items", "relatedDocuments"] {
                if let Some(value) = object.get_mut(key) {
                    if key == "relatedDocuments" {
                        if let Some(docs) = value.as_object_mut() {
                            for report in docs.values_mut() {
                                translate_report(report, catalog);
                            }
                        }
                    } else {
                        translate_report(value, catalog);
                    }
                }
            }
        }
        _ => {}
    }
}
fn normalize_code(value: &Value) -> Option<String> {
    let raw = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|n| n.to_string()))?;
    let bytes = raw.as_bytes();
    for index in 0..bytes.len().saturating_sub(4) {
        if bytes[index].eq_ignore_ascii_case(&b'e')
            && bytes[index + 1..index + 5].iter().all(u8::is_ascii_digit)
        {
            return Some(raw[index..index + 5].to_ascii_uppercase());
        }
    }
    Some(raw)
}
fn translate_diagnostic(diagnostic: &mut Value, catalog: &Catalog) {
    let Some(original) = diagnostic
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let code = diagnostic.get("code").and_then(normalize_code);
    let rendered = diagnostic.pointer("/data/rendered").and_then(Value::as_str);
    if let Some(text) = translated_message(&original, code.as_deref(), rendered, catalog) {
        diagnostic["message"] = Value::String(text);
    }
    if let Some(related) = diagnostic
        .get_mut("relatedInformation")
        .and_then(Value::as_array_mut)
    {
        for note in related {
            if let Some(original) = note.get("message").and_then(Value::as_str) {
                if let Some(text) = translated_message(original, None, None, catalog) {
                    note["message"] = Value::String(text);
                }
            }
        }
    }
}
fn translated_message(
    original: &str,
    code: Option<&str>,
    rendered: Option<&str>,
    catalog: &Catalog,
) -> Option<String> {
    if original.starts_with("中文：") && original.contains("\n\n原文：\n") {
        return None;
    }
    let contextual = parse_literal_overflow(original, rendered)
        .map(|details| literal_overflow_summary(&details))
        .or_else(|| context_title(original));
    let entry = code.and_then(|code| catalog.get(code));
    let phrase = message_rule(original);
    let selected = phrase.as_ref().or(entry);
    let title = contextual.or_else(|| {
        selected
            .and_then(|v| v.get("chinese"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    })?;
    let explanation = selected
        .and_then(|v| v.get("explanation"))
        .and_then(Value::as_str);
    let help = explanation
        .map(|text| format!("\n可以这样检查：{text}"))
        .unwrap_or_default();
    Some(format!("中文：{title}{help}\n\n原文：\n{original}"))
}
fn context_title(message: &str) -> Option<String> {
    let line = message.lines().next()?.trim();
    let lower = line.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("expected ") {
        if let Some((expected, actual)) = rest
            .split_once(" arguments, found ")
            .or_else(|| rest.split_once(" argument, found "))
        {
            if expected.chars().all(|c| c.is_ascii_digit())
                && actual.chars().all(|c| c.is_ascii_digit())
            {
                return Some(format!("需要 {expected} 个参数，实际传了 {actual} 个"));
            }
        }
    }
    let quoted = || {
        let start = line.find('`')? + 1;
        let end = line[start..].find('`')? + start;
        Some(&line[start..end])
    };
    if lower.starts_with("unused variable: ") {
        return quoted().map(|s| format!("变量 `{s}` 没有使用"));
    }
    if lower.starts_with("unused import: ") {
        return quoted().map(|s| format!("导入的 `{s}` 没有使用"));
    }
    if lower.starts_with("the trait bound ") && lower.contains("is not satisfied") {
        return quoted().map(|s| format!("未满足约束：`{s}`"));
    }
    if lower.starts_with("cannot find ") && lower.contains("in this scope") {
        return quoted().map(|s| format!("当前作用域找不到 `{s}`"));
    }
    let lower = message.to_ascii_lowercase();
    let start = lower.find("expected ")? + "expected ".len();
    let found = lower[start..].find("found ")? + start;
    let expected = message[start..found].trim().trim_end_matches(',').trim();
    let actual = message[found + "found ".len()..].lines().next()?.trim();
    if expected.is_empty() || actual.is_empty() {
        return None;
    }
    Some(format!("需要 {expected}，实际是 {actual}"))
}
fn message_rule(message: &str) -> Option<Value> {
    static RULES: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    let rules = RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/message-rules.json"))
            .expect("validated message rules")
    });
    let lower = message.to_ascii_lowercase();
    rules
        .iter()
        .find(|rule| {
            rule["any"].as_array().is_some_and(|phrases| {
                phrases
                    .iter()
                    .any(|s| s.as_str().is_some_and(|s| lower.contains(s)))
            })
        })
        .cloned()
}
fn load_catalog() -> Catalog {
    let root = env::current_exe()
        .ok()
        .and_then(|p| p.parent()?.parent().map(Path::to_path_buf));
    let path = root.map(|p| p.join("dist/catalog.json"));
    if let Some(catalog) = path
        .and_then(|p| fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice::<Catalog>(&bytes).ok())
    {
        return catalog;
    }
    eprintln!(
        "rust-analyzer-lingo: 未找到完整词典，使用常见错误解释；其他诊断保留原文。请重新安装扩展。"
    );
    serde_json::from_str(include_str!("../../src/diagnostic-details.json"))
        .expect("validated diagnostic details")
}
fn find_real_server() -> io::Result<PathBuf> {
    let file = env::var_os(REAL_SERVER_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "请在扩展中重新启用原始诊断中文显示，以更新服务器连接",
            )
        })?;
    let current = env::current_exe()?;
    if file.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .trim_end_matches(".exe")
            .eq_ignore_ascii_case("rust-analyzer-lingo-proxy")
    }) || fs::canonicalize(&file).ok() == fs::canonicalize(current).ok()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "代理不能连接自身",
        ));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn catalog() -> Catalog {
        serde_json::from_str(include_str!("../../src/diagnostic-details.json")).unwrap()
    }
    fn diagnostic(message: &str, code: &str) -> Value {
        json!({"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"message":message,"code":code,"source":"rustc","severity":1})
    }
    #[test]
    fn preserves_context_metadata_and_distinct_diagnostics() {
        let mut first = diagnostic("the trait bound `X: Foo` is not satisfied", "E0277");
        first["data"] = json!({"rendered":"original", "opaque": [1,2]});
        first["codeDescription"] =
            json!({"href":"https://doc.rust-lang.org/error_codes/E0277.html"});
        first["relatedInformation"] =
            json!([{"message":"compiler-specific binding note","location":{"uri":"file:///x.rs"}}]);
        let mut values = json!([
            first.clone(),
            diagnostic("the trait bound `X: Bar` is not satisfied", "E0277")
        ]);
        translate_report(&mut values, &catalog());
        assert_eq!(values.as_array().unwrap().len(), 2);
        assert!(values[0]["message"].as_str().unwrap().contains("X: Foo"));
        assert!(values[1]["message"].as_str().unwrap().contains("X: Bar"));
        for key in [
            "range",
            "code",
            "source",
            "severity",
            "data",
            "codeDescription",
            "relatedInformation",
        ] {
            assert_eq!(values[0][key], first[key]);
        }
    }
    #[test]
    fn unknown_diagnostic_is_unchanged() {
        let original = diagnostic("future analyzer diagnostic", "new-check");
        let mut value = original.clone();
        translate_report(&mut value, &catalog());
        assert_eq!(value, original);
    }
    #[test]
    fn preserves_original_and_is_idempotent() {
        let original = "mismatched types\nexpected `u32`, found `&str`";
        let mut value = diagnostic(original, "E0308");
        translate_report(&mut value, &catalog());
        assert!(value["message"]
            .as_str()
            .unwrap()
            .contains("需要 `u32`，实际是 `&str`"));
        assert!(value["message"].as_str().unwrap().ends_with(original));
        let once = value.clone();
        translate_report(&mut value, &catalog());
        assert_eq!(value, once);
    }
    #[test]
    fn supports_chinese_identifiers_and_unicode_without_offset_panics() {
        assert_eq!(
            context_title("unused variable: `变量`"),
            Some("变量 `变量` 没有使用".to_owned())
        );
        assert_eq!(
            context_title("İİ expected `é`, found `x`"),
            Some("需要 `é`，实际是 `x`".to_owned())
        );
    }
    #[test]
    fn hover_and_unrelated_traffic_are_byte_preserved() {
        let pending = Arc::new(Mutex::new(Pending::default()));
        track_request(br#"{"id":7,"method":"textDocument/hover"}"#, &pending);
        let body = br#"{ "id": 7, "result": {"contents":"value of literal: 42"} }"#;
        assert!(transform_body(body, &pending, &catalog()).is_none());
        assert!(pending.lock().unwrap().requests.is_empty());
    }
    #[test]
    fn pull_reports_partial_results_and_related_documents() {
        let pending = Arc::new(Mutex::new(Pending::default()));
        track_request(
            br#"{"id":1,"method":"workspace/diagnostic","params":{"partialResultToken":"p"}}"#,
            &pending,
        );
        let diag = diagnostic("mismatched types", "E0308");
        let partial = json!({"method":"$/progress","params":{"token":"p","value":{"items":[{"uri":"file:///x","kind":"full","items":[diag.clone()]}]}}});
        assert!(
            transform_body(&serde_json::to_vec(&partial).unwrap(), &pending, &catalog()).is_some()
        );
        let response = json!({"id":1,"result":{"kind":"full","items":[diag.clone()],"relatedDocuments":{"file:///y":{"kind":"full","items":[diag]}}}});
        let output = transform_body(
            &serde_json::to_vec(&response).unwrap(),
            &pending,
            &catalog(),
        )
        .unwrap();
        let output: Value = serde_json::from_slice(&output).unwrap();
        assert!(
            output["result"]["relatedDocuments"]["file:///y"]["items"][0]["message"]
                .as_str()
                .unwrap()
                .starts_with("中文：")
        );
        assert!(pending.lock().unwrap().progress.is_empty());
        assert!(
            transform_body(&serde_json::to_vec(&partial).unwrap(), &pending, &catalog()).is_none()
        );
    }
    #[test]
    fn framing_checks_bytes_truncation_and_limits() {
        let body = "中文 message".as_bytes();
        let mut wire = Vec::new();
        write_lsp_message(&mut wire, body).unwrap();
        assert_eq!(
            read_lsp_message(&mut io::Cursor::new(wire))
                .unwrap()
                .unwrap(),
            body
        );
        for invalid in [
            "Content-Length: 3\r\n\r\nx",
            "Content-Length: 3\r\n",
            "Content-Length: 999999999\r\n\r\n",
            "Content-Length: 1\r\nContent-Length: 1\r\n\r\nx",
        ] {
            assert!(read_lsp_message(&mut io::Cursor::new(invalid)).is_err());
        }
    }
    #[test]
    fn overflow_keeps_rendered_output_intact() {
        let mut value = diagnostic("literal out of range for `i8`", "overflowing_literals");
        value["data"] = json!({"rendered":"the literal `12329` does not fit into the type `i8` whose range is `-128..=127`\nconsider using the type `i16`"});
        let data = value["data"].clone();
        translate_report(&mut value, &catalog());
        assert!(value["message"].as_str().unwrap().contains("12329"));
        assert_eq!(value["data"], data);
    }
}
