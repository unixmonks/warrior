//! Turning what the user typed into argv for `task`. There is no command
//! allowlist: it's the user's own machine and their own `task`.

use crate::error::{input, Result};

/// Split a command line the way a shell would: whitespace, quotes,
/// backslashes. A quote only opens at the start of a word (or after `:` or
/// `=`), so "call mom's friend" stays three words instead of failing on an
/// unclosed quote.
pub fn tokenize(line: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else if ch == '\\' && q == '"' && chars.peek().is_some() {
                cur.push(chars.next().unwrap());
            } else {
                cur.push(ch);
            }
        } else if (ch == '"' || ch == '\'') && (!has || cur.ends_with(':') || cur.ends_with('=')) {
            quote = Some(ch);
            has = true;
        } else if ch == '\\' && chars.peek().is_some() {
            cur.push(chars.next().unwrap());
            has = true;
        } else if ch.is_whitespace() {
            if has || !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            has = false;
        } else {
            cur.push(ch);
            has = true;
        }
    }
    if quote.is_some() {
        return Err(input("Unclosed quote"));
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

pub fn assert_uuid(s: &str) -> Result<&str> {
    if is_uuid(s) {
        Ok(s)
    } else {
        Err(input("Invalid task id"))
    }
}

/// Date values: Taskwarrior synonyms (eow, tomorrow, now+3d) or ISO dates.
pub fn date_value(v: &str) -> Result<String> {
    let s = v.trim();
    let ok = !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_alphanumeric() || "_:+-.".contains(c));
    if !ok {
        return Err(input(format!("\"{v}\" isn't a date Taskwarrior understands")));
    }
    // Date pickers give 2026-10-10T17:00; task wants seconds too.
    let b = s.as_bytes();
    if b.len() == 16 && b[10] == b'T' && b[13] == b':' && b[4] == b'-' {
        return Ok(format!("{s}:00"));
    }
    Ok(s.to_string())
}

pub fn project_value(v: &str) -> Result<String> {
    let s = v.trim();
    if s.chars().count() > 100 || s.chars().any(|c| c.is_whitespace() || "\"'\\".contains(c)) {
        return Err(input("Project names can't contain spaces or quotes"));
    }
    Ok(s.to_string())
}

pub fn tag_value(v: &str) -> Result<String> {
    let trimmed = v.trim();
    let s = trimmed.strip_prefix('+').unwrap_or(trimmed);
    let bad = s.is_empty()
        || s.chars().count() > 64
        || s.starts_with(['+', '-'])
        || s.chars().any(|c| c.is_whitespace() || "\"'\\".contains(c));
    if bad {
        return Err(input(format!("\"{v}\" isn't a valid tag")));
    }
    if s.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(input(format!("\"{s}\" is a reserved virtual tag")));
    }
    Ok(s.to_string())
}

pub fn recur_value(v: &str) -> Result<String> {
    let s = v.trim();
    if s.len() > 20 || !s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') {
        return Err(input(format!("\"{v}\" isn't a recurrence period")));
    }
    Ok(s.to_string())
}

pub fn priority_value(v: &str) -> Result<String> {
    match v {
        "" | "H" | "M" | "L" => Ok(v.to_string()),
        _ => Err(input("Priority must be H, M, L or empty")),
    }
}

/// Logical operators and grouping that are fine as bare words in a filter.
const FILTER_WORDS: &[&str] = &["and", "or", "xor", "not", "(", ")"];

/// Check a stored filter (a reminder rule) before it's put in front of a
/// command. `task` runs the first command word it finds, so a filter
/// containing `delete` or `done` would change tasks instead of listing them.
/// `commands` is the output of `task _commands`. Bare words that are a
/// command, or could abbreviate one, are refused.
pub fn parse_filter(filter: &str, commands: &[String]) -> Result<Vec<String>> {
    let args = tokenize(filter.trim())?;
    if args.len() > 50 {
        return Err(input("Filter is too long"));
    }
    for tok in &args {
        if tok == "--" {
            return Err(input("Filters can't contain --"));
        }
        let t = tok.to_lowercase();
        if t.contains(':') || t.contains('=') || t.starts_with('+') || t.starts_with('-') || t.starts_with('/') {
            continue;
        }
        if FILTER_WORDS.contains(&t.as_str()) || t.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '-') {
            continue;
        }
        if commands.iter().any(|c| *c == t || (t.len() >= 2 && c.starts_with(&t))) {
            return Err(input(format!(
                "Filters can't contain \"{tok}\", because task would read it as a command. To search descriptions, use description.contains:{tok}"
            )));
        }
    }
    Ok(args)
}

/// Wrap a filter in parentheses so it combines safely with the app's own terms.
pub fn grouped(filter: Vec<String>) -> Vec<String> {
    if filter.is_empty() {
        return filter;
    }
    let mut out = Vec::with_capacity(filter.len() + 2);
    out.push("(".to_string());
    out.extend(filter);
    out.push(")".to_string());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(s: &str) -> Vec<String> {
        tokenize(s).unwrap()
    }

    #[test]
    fn tokenizes_like_a_shell() {
        assert_eq!(tok("call mom's friend"), ["call", "mom's", "friend"]);
        assert_eq!(tok(r#"add "two words" project:x"#), ["add", "two words", "project:x"]);
        assert_eq!(tok(r#"project:"a b" x"#), ["project:a b", "x"]);
        assert_eq!(tok(r"a\ b c"), ["a b", "c"]);
        assert_eq!(tok("  spaced   out  "), ["spaced", "out"]);
        assert_eq!(tok(r#""""#), [""]);
        assert!(tokenize(r#""open"#).is_err());
    }

    #[test]
    fn checks_uuids() {
        assert!(is_uuid("6703cd38-95cd-442b-8d9e-4aa2bec2f1a2"));
        assert!(!is_uuid("6703cd38-95cd-442b-8d9e-4aa2bec2f1a"));
        assert!(!is_uuid("6703CD38-95cd-442b-8d9e-4aa2bec2f1a2"));
        assert!(!is_uuid("1"));
    }

    #[test]
    fn validates_values() {
        assert_eq!(date_value("2026-10-10T17:00").unwrap(), "2026-10-10T17:00:00");
        assert_eq!(date_value(" eow ").unwrap(), "eow");
        assert_eq!(date_value("now+3d").unwrap(), "now+3d");
        assert!(date_value("fri due:mon").is_err());
        assert_eq!(project_value("home.garden").unwrap(), "home.garden");
        assert!(project_value("a b").is_err());
        assert_eq!(tag_value("+errand").unwrap(), "errand");
        assert!(tag_value("two words").is_err());
        assert!(tag_value("PENDING").is_err());
        assert!(tag_value("-x").is_err());
        assert!(tag_value("++x").is_err());
        assert_eq!(recur_value("weekly").unwrap(), "weekly");
        assert!(recur_value("weekly due:x").is_err());
        assert!(priority_value("X").is_err());
    }

    #[test]
    fn refuses_commands_in_filters() {
        let cmds: Vec<String> = ["add", "delete", "done", "export", "modify"].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_filter("project:work +urgent", &cmds).unwrap(), ["project:work", "+urgent"]);
        assert_eq!(parse_filter("( project:a or project:b )", &cmds).unwrap().len(), 5);
        assert!(parse_filter("project:work delete", &cmds).is_err());
        assert!(parse_filter("del", &cmds).is_err());
        assert!(parse_filter("x -- y", &cmds).is_err());
        assert!(parse_filter("milk", &cmds).is_ok());
    }
}
