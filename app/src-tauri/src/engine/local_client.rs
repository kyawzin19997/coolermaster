//! Local HTTP client shared by the terminal commands and diagnostics.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

const TOO_OLD: &str = "This command requires a newer version of MasterDeck.";
const NOT_RUNNING: &str = "MasterDeck is not running. Start it and try again.";

/// How the server reaches the app: `(method, path, body)` -> the JSON answer or an error text.
pub trait Api {
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String>;
}

/// The running app over its local HTTP API; the token and port are read on every call, so a
/// restarted app (new port) is found again.
pub struct Http {
    pub dir: PathBuf,
}

impl Api for Http {
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let token = std::fs::read_to_string(self.dir.join("api-token")).map_err(|_| NOT_RUNNING.to_string())?;
        let port: u16 = std::fs::read_to_string(self.dir.join("api-http-port")).ok().and_then(|p| p.trim().parse().ok()).ok_or_else(|| NOT_RUNNING.to_string())?;
        let (status, answer) = request(port, token.trim(), method, path, body).map_err(|_| NOT_RUNNING.to_string())?;
        // an older MasterDeck takes unknown POSTs as plugin events (202) and answers other paths with
        // its usage line (404)
        let usage = answer.get("error").and_then(Value::as_str).is_some_and(|e| e.starts_with("use GET /api/state"));
        match status {
            202 => Err(TOO_OLD.into()),
            404 if usage || answer.get("error").is_none() => Err(TOO_OLD.into()),
            200..=299 => Ok(answer),
            401 => Err("MasterDeck refused the request (the API token changed); restart MasterDeck and try again.".into()),
            _ => Err(answer.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("MasterDeck answered {status}"))),
        }
    }
}

/// One HTTP/1.1 request to 127.0.0.1 (`Connection: close`): the status and the JSON body.
pub fn request(port: u16, token: &str, method: &str, path: &str, body: Option<&Value>) -> std::io::Result<(u16, Value)> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(800))?;
    // pictures and animations take a few seconds to make
    stream.set_read_timeout(Some(Duration::from_secs(90)))?;
    let body = body.map(Value::to_string).unwrap_or_default();
    let head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(|| std::io::Error::other("no HTTP answer"))?;
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| std::io::Error::other("no HTTP status"))?;
    // tiny_http sends bigger answers (the catalog, 40 KB+) in chunks: without decoding them the
    // JSON did not parse and list_actions / list_icons gave the assistant empty lists
    let chunked = head.lines().any(|l| l.to_ascii_lowercase().replace(' ', "") == "transfer-encoding:chunked");
    let body = if chunked { dechunk(body) } else { body.to_string() };
    Ok((status, serde_json::from_str(&body).unwrap_or(Value::Null)))
}

/// The body of a `Transfer-Encoding: chunked` answer: hex size, CRLF, data, CRLF ... `0`.
fn dechunk(mut rest: &str) -> String {
    let mut out = String::new();
    while let Some((size, after)) = rest.split_once("\r\n") {
        let Ok(n) = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16) else { break };
        if n == 0 || after.len() < n {
            if n > 0 {
                out.push_str(after);
            }
            break;
        }
        out.push_str(&after[..n]);
        rest = after[n..].strip_prefix("\r\n").unwrap_or(&after[n..]);
    }
    out
}

/// Where the app keeps `api-token` and `api-http-port` (Tauri's app data dir for `dev.hubdeck.app`).
pub(crate) fn data_dir() -> Option<std::path::PathBuf> {
    const ID: &str = "dev.hubdeck.app";
    // Use the isolated data directory when running an automation copy.
    if let Some(a) = crate::automation::get() {
        return Some(a.data_dir.clone());
    }
    #[cfg(windows)]
    return std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join(ID));
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Application Support").join(ID));
    #[cfg(all(unix, not(target_os = "macos")))]
    return std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share"))).map(|d| d.join(ID));
}
