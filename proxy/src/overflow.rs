#[derive(Debug, Eq, PartialEq)]
pub(crate) struct LiteralOverflowDetails {
    target_type: String,
    literal: Option<String>,
    range: Option<String>,
    suggested_type: Option<String>,
}

pub(crate) fn parse_literal_overflow(
    message: &str,
    rendered: Option<&str>,
) -> Option<LiteralOverflowDetails> {
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

pub(crate) fn literal_overflow_summary(details: &LiteralOverflowDetails) -> String {
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
