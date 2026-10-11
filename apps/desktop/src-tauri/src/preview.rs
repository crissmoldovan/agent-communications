use crate::control::{b3_contract::B3Request, types::ControlError};
use serde_json::{json, Value};

/// Same character table as core/chars.ts. JSON canonicalisation precedes neutralisation, as in B3's terminal.
fn dangerous(c: char) -> bool {
    let n = c as u32;
    (n < 0x20 && n != 9 && n != 10)
        || (0x7f..=0x9f).contains(&n)
        || [
            (0xad, 0xad),
            (0x34f, 0x34f),
            (0x61c, 0x61c),
            (0x115f, 0x1160),
            (0x17b4, 0x17b5),
            (0x180b, 0x180f),
            (0x200b, 0x200f),
            (0x2028, 0x202e),
            (0x2060, 0x2064),
            (0x2066, 0x206f),
            (0x3164, 0x3164),
            (0xfe00, 0xfe0f),
            (0xfeff, 0xfeff),
            (0xffa0, 0xffa0),
            (0xe0000, 0xe007f),
        ]
        .iter()
        .any(|(a, b)| (*a..=*b).contains(&n))
}

pub fn neutralise(text: &str) -> String {
    let visible: String = text
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| !dangerous(*c))
        .collect();
    let tokens = regex::Regex::new(r"(?i)<\|(?:im_start|im_end|im_sep|endoftext|eot_id|start_header_id|end_header_id|begin_of_text|system|user|assistant|end|fim_\w+)\|>|\[/?INST\]|<</?SYS>>|</?s>|<start_of_turn>|<end_of_turn>").unwrap();
    let value = tokens.replace_all(&visible, "[control token removed]");
    let roles = regex::Regex::new(
        r"(?i)(^|\n)(\s*)(Human|Assistant|System|User|Developer|Tool|Function)\s*:",
    )
    .unwrap();
    let value = roles.replace_all(&value, "${1}${2}${3} (quoted):");
    let envelopes =
        regex::Regex::new(r"(?i)<(/?)\s*(untrusted-content|untrusted-email-content)").unwrap();
    envelopes.replace_all(&value, "&lt;${1}${2}").into_owned()
}

/// ECMAScript's `Number::toString` starts from the shortest round-trippable decimal, then uses fixed notation for
/// exponents -6 through 20 and scientific notation everywhere else. Rust's formatter has different presentation
/// cut-offs, so canonical JSON must make that final choice itself.
fn ecmascript_number(number: f64) -> String {
    if number == 0.0 {
        // JSON.parse("-0") preserves the IEEE sign, but JavaScript JSON.stringify and the B3 renderer emit `0`.
        return "0".into();
    }
    let sign = if number.is_sign_negative() { "-" } else { "" };
    let raw = number.abs().to_string();
    let (coefficient, adjustment) = match raw.split_once(['e', 'E']) {
        Some((coefficient, exponent)) => (coefficient, exponent.parse::<i32>().unwrap()),
        None => (raw.as_str(), 0),
    };
    let decimal = coefficient.find('.').unwrap_or(coefficient.len());
    let digits: String = coefficient
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let leading = digits.bytes().take_while(|digit| *digit == b'0').count();
    let significant = digits[leading..].trim_end_matches('0');
    debug_assert!(!significant.is_empty());
    let exponent = adjustment + decimal as i32 - leading as i32 - 1;

    if (-6..=20).contains(&exponent) {
        let point = exponent + 1;
        if point <= 0 {
            format!("{sign}0.{}{}", "0".repeat((-point) as usize), significant)
        } else if point as usize >= significant.len() {
            format!(
                "{sign}{significant}{}",
                "0".repeat(point as usize - significant.len())
            )
        } else {
            format!(
                "{sign}{}.{}",
                &significant[..point as usize],
                &significant[point as usize..]
            )
        }
    } else {
        let tail = if significant.len() > 1 {
            format!(".{}", &significant[1..])
        } else {
            String::new()
        };
        format!(
            "{sign}{}{tail}e{}{exponent}",
            &significant[..1],
            if exponent >= 0 { "+" } else { "" }
        )
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            // JavaScript compares UTF-16 code units; UTF-8/Rust scalar ordering differs for supplementary keys.
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Number(number) => ecmascript_number(number.as_f64().unwrap()),
        _ => serde_json::to_string(value).unwrap(),
    }
}

pub fn render_disclosure_preview(preview: &Value) -> Result<Vec<u8>, ControlError> {
    B3Request::parse(
        json!({"operation":"approvalView","args":{"approvalId":"validate","digest":"validate"}}),
    )?
    .result(preview.clone())?;
    if preview["kind"] != "READY" {
        return Ok(format!("Approval view: {}", preview["kind"].as_str().unwrap()).into_bytes());
    }
    let expires = preview["challenge"]["expiresAt"]
        .as_i64()
        .ok_or_else(|| ControlError::new("B3_RESULT_SCHEMA", "invalid expiry"))?;
    let datetime = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(expires) * 1_000_000)
        .map_err(|_| ControlError::new("B3_RESULT_SCHEMA", "expiry outside range"))?;
    let iso = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        datetime.year(),
        u8::from(datetime.month()),
        datetime.day(),
        datetime.hour(),
        datetime.minute(),
        datetime.second(),
        datetime.millisecond()
    );
    Ok(format!(
        "Approval {}\nDigest {}\nPreview {}\nChallenge {}\nExpires {}",
        preview["approvalId"].as_str().unwrap(),
        preview["digest"].as_str().unwrap(),
        neutralise(&canonical_json(&preview["preview"])),
        preview["challenge"]["challenge"].as_str().unwrap(),
        iso
    )
    .into_bytes())
}
