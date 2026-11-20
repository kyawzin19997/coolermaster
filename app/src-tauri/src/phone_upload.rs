//! A temporary file inbox. The network listeners have no access to the desktop command API.

use std::{
    fs,
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

const PAIR_TIME: Duration = Duration::from_secs(5 * 60);
const SESSION_TIME: Duration = Duration::from_secs(60 * 60);
const LAN_PORT: u16 = 46616;
const TUNNEL_PORT: u16 = 46617;
const CHUNK: usize = 512 * 1024;
const FILE_LIMIT: u64 = 300 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 1024 * 1024 * 1024;
const FILE_COUNT: usize = 32;
const MOBILE: &str = include_str!("../assets/phone/index.html");
const SCRIPT: &str = include_str!("../assets/phone/upload.js");
const CSS: &str = include_str!("../assets/phone/upload.css");

type Result<T> = std::result::Result<T, String>;
type Http = std::result::Result<Value, (u16, String)>;
type Body = Full<Bytes>;

#[derive(Default)]
pub struct Uploads(Mutex<Option<Arc<Session>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    url: String,
    qr: String,
}

struct Session {
    started: Instant,
    key: String,
    probe: String,
    folder: PathBuf,
    closed: AtomicBool,
    local: Option<Link>,
    remote: Mutex<(Option<Link>, String)>,
    state: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    phone: Option<Phone>,
    files: Vec<File>,
}

struct Phone {
    client: String,
    ticket: String,
    code: String,
    status: &'static str,
    mode: &'static str,
    seen: Instant,
}

#[derive(Deserialize)]
struct FileInfo {
    name: String,
    size: u64,
    digest: String,
}

struct File {
    id: String,
    info: FileInfo,
    path: PathBuf,
    received: u64,
    complete: bool,
    kind: &'static str,
    started: Instant,
    last: Instant,
    checked: Sha256,
}

impl File {
    fn summary(&self) -> Value {
        let speed = if self.complete || self.last.elapsed() > Duration::from_secs(4) { 0.0 } else { self.received as f64 / self.started.elapsed().as_secs_f64().max(0.25) };
        json!({"id":self.id,"name":self.info.name,"size":self.info.size,"bytes": self.received,"complete": self.complete,"speed":speed,"kind":self.kind})
    }
}

fn secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}
fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn lan_ip() -> Option<Ipv4Addr> {
    // A UDP connect selects the default interface without sending a packet. Interface
    // enumeration also covers Wi-Fi networks that have no gateway or Internet access.
    let route = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok().and_then(|s| {
        s.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
        match s.local_addr().ok()?.ip() {
            IpAddr::V4(ip) if ip.is_private() => Some(ip),
            _ => None,
        }
    });
    route.or_else(|| {
        let networks = sysinfo::Networks::new_with_refreshed_list();
        networks.values().flat_map(|data| data.ip_networks()).find_map(|net| match net.addr {
            IpAddr::V4(ip) if ip.is_private() => Some(ip),
            _ => None,
        })
    })
}

fn make_link(origin: &str, key: &str) -> Result<Link> {
    use qrcode::render::svg;
    let url = format!("{origin}/#{key}");
    let qr = qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::M).map_err(|e| e.to_string())?.render::<svg::Color>().min_dimensions(252, 252).build();
    Ok(Link { url, qr })
}

fn tunnel_origin(value: &str) -> Option<(String, String)> {
    let url = tauri::Url::parse(value.trim()).ok()?;
    let domain = url.domain()?;
    if url.scheme() != "https"
        || !domain.contains('.')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.port(), None | Some(443))
    {
        return None;
    }
    Some((url.origin().ascii_serialization(), domain.into()))
}

fn listener(addr: SocketAddr) -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind(addr)?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

impl Session {
    fn expired(&self) -> bool {
        self.closed.load(Ordering::Acquire) || self.started.elapsed() >= SESSION_TIME
    }

    fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        let remote = self.remote.lock().unwrap();
        json!({"local":self.local,"remote":remote.0,"remoteStatus":remote.1,"expired":self.expired(),
            "pairSeconds":PAIR_TIME.saturating_sub(self.started.elapsed()).as_secs(),
            "phone":state.phone.as_ref().map(|p| json!({"code":p.code,"status":p.status,"mode":p.mode,"online":p.seen.elapsed() < Duration::from_secs(8)})),
            "files":state.files.iter().map(File::summary).collect::<Vec<_>>()})
    }

    fn cancel(&self, file: &str) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let index = state.files.iter().position(|f| f.id == file && !f.complete).ok_or("There is no partial upload to cancel.")?;
        let path = &state.files[index].path;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        state.files.remove(index);
        Ok(())
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let state = self.state.lock().unwrap();
        for file in state.files.iter().filter(|f| !f.complete) {
            let _ = fs::remove_file(&file.path);
        }
        if state.files.iter().all(|f| !f.complete) {
            let _ = fs::remove_dir(&self.folder);
        }
    }
}

impl Uploads {
    fn get(&self) -> Result<Arc<Session>> {
        self.0.lock().unwrap().clone().ok_or_else(|| "Open Upload from Phone to start a session.".into())
    }
}

#[tauri::command]
pub async fn phone_start(app: tauri::AppHandle) -> Result<Value> {
    let folder = crate::automation::get().map(|a| a.data_dir.clone()).map_or_else(|| app.path().app_data_dir().map_err(|e| e.to_string()), Ok)?;
    tauri::async_runtime::spawn_blocking(move || {
        let uploads = app.state::<Uploads>();
        let mut current = uploads.0.lock().unwrap();
        if let Some(prior) = current.take() {
            prior.close();
        }
        let key = secret();
        let local = lan_ip().and_then(|ip| {
            let server = listener(SocketAddr::from((ip, LAN_PORT))).or_else(|_| listener(SocketAddr::from((ip, 0)))).ok()?;
            let host = server.local_addr().ok()?.to_string();
            Some((make_link(&format!("http://{host}"), &key).ok()?, server, host))
        });
        let remote_setting = std::env::var("MASTERDECK_UPLOAD_HTTPS").ok();
        let remote = remote_setting.as_deref().and_then(tunnel_origin).and_then(|(origin, host)| {
            let address = SocketAddr::from((Ipv4Addr::LOCALHOST, TUNNEL_PORT));
            // A renewed session may start before the previous listener finishes shutting down.
            let mut server = listener(address);
            for _ in 0..4 {
                if server.is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(80));
                server = listener(address);
            }
            Some((make_link(&origin, &key).ok()?, server.ok()?, host, origin))
        });
        let remote_status = if remote.is_some() {
            "Checking the HTTPS relay…"
        } else if remote_setting.is_some() {
            "Check the HTTPS relay address and local port 46617."
        } else {
            "Internet mode is unavailable until an HTTPS relay is configured."
        };
        let session = Arc::new(Session {
            started: Instant::now(),
            key,
            probe: id(),
            folder: folder.join("phone-inbox").join(id()),
            closed: AtomicBool::new(false),
            local: local.as_ref().map(|(link, _, _)| link.clone()),
            remote: Mutex::new((None, remote_status.into())),
            state: Mutex::new(Inner::default()),
        });
        if let Some((_, server, host)) = local {
            serve(server, session.clone(), host, "local");
        }
        if let Some((link, server, host, origin)) = remote {
            serve(server, session.clone(), host, "internet");
            let check = session.clone();
            std::thread::spawn(move || {
                let agent: ureq::Agent = crate::engine::calls::builder().max_redirects(0).timeout_global(Some(Duration::from_secs(8))).build().into();
                let matches = agent
                    .get(&format!("{origin}/health"))
                    .call()
                    .ok()
                    .filter(|r| r.status() == 200)
                    .and_then(|mut r| r.body_mut().with_config().limit(128).read_to_string().ok())
                    .is_some_and(|s| s == check.probe);
                *check.remote.lock().unwrap() =
                    if matches { (Some(link), "HTTPS relay connected".into()) } else { (None, "The HTTPS relay could not reach MasterDeck. Check the tunnel and try again.".into()) };
            });
        }
        let snapshot = session.snapshot();
        *current = Some(session);
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn phone_status(uploads: State<'_, Uploads>) -> Result<Value> {
    Ok(uploads.get()?.snapshot())
}

#[tauri::command]
pub fn phone_approve(uploads: State<'_, Uploads>, code: String, approve: bool) -> Result<()> {
    let session = uploads.get()?;
    if session.expired() || session.started.elapsed() >= PAIR_TIME {
        return Err("The pairing code expired. Start a new session.".into());
    }
    let mut state = session.state.lock().unwrap();
    let phone = state.phone.as_mut().filter(|p| p.code == code && p.status == "pending").ok_or("The pairing request changed.")?;
    phone.status = if approve { "approved" } else { "denied" };
    Ok(())
}

#[tauri::command]
pub fn phone_cancel(uploads: State<'_, Uploads>, file: String) -> Result<()> {
    uploads.get()?.cancel(&file)
}

fn received(uploads: &Uploads, file: &str) -> Result<PathBuf> {
    let session = uploads.get()?;
    let state = session.state.lock().unwrap();
    state.files.iter().find(|f| f.id == file && f.complete).map(|f| f.path.clone()).ok_or_else(|| "This upload has not finished.".into())
}

#[tauri::command]
pub fn phone_path(uploads: State<'_, Uploads>, file: String) -> Result<String> {
    received(&uploads, &file).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn phone_save(app: tauri::AppHandle, file: String, path: String) -> Result<()> {
    let source = received(&app.state::<Uploads>(), &file)?;
    tauri::async_runtime::spawn_blocking(move || {
        if Path::new(&path).canonicalize().ok().zip(source.canonicalize().ok()).is_some_and(|(dst, src)| dst == src) {
            return Ok(());
        }
        fs::copy(source, path).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn phone_stop(uploads: State<'_, Uploads>) {
    if let Some(session) = uploads.0.lock().unwrap().as_ref() {
        session.close();
    }
}

fn header<'a>(req: &'a Request<Incoming>, name: &str) -> Option<&'a str> {
    req.headers().get(name)?.to_str().ok()
}

fn respond(status: u16, mime: &'static str, body: impl Into<Bytes>) -> Response<Body> {
    let mut response = Response::builder().status(status);
    for (name, value) in [
        ("Content-Type", mime),
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "no-referrer"),
        ("X-Content-Type-Options", "nosniff"),
        ("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"),
    ] {
        response = response.header(name, value);
    }
    response.body(Full::new(body.into())).expect("static response headers")
}

fn serve(listener: TcpListener, session: Arc<Session>, host: String, mode: &'static str) {
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        let connections = Arc::new(tokio::sync::Semaphore::new(16));
        while !session.expired() {
            let Ok(accepted) = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await else { continue };
            let Ok((stream, _)) = accepted else { break };
            let Ok(permit) = connections.clone().try_acquire_owned() else { continue };
            let host = host.clone();
            let session = session.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let service = service_fn(move |req| request(session.clone(), req, host.clone(), mode));
                let serve = http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(5)).keep_alive(false).serve_connection(TokioIo::new(stream), service);
                let _ = tokio::time::timeout(Duration::from_secs(16), serve).await;
            });
        }
        let _ = tauri::async_runtime::spawn_blocking(move || session.close()).await;
    });
}

async fn request(session: Arc<Session>, req: Request<Incoming>, host: String, mode: &'static str) -> std::result::Result<Response<Body>, std::convert::Infallible> {
    if !header(&req, "host").is_some_and(|name| name.eq_ignore_ascii_case(&host)) {
        return Ok(respond(403, "text/plain", "Invalid request origin"));
    }
    if session.expired() {
        return Ok(respond(410, "application/json", json!({"error":"This session ended. Scan a new QR code."}).to_string()));
    }
    if req.method() == Method::GET {
        let static_file = match req.uri().path_and_query().map(|url| url.as_str()) {
            Some("/") => Some(("text/html; charset=utf-8", MOBILE)),
            Some("/upload.js") => Some(("text/javascript; charset=utf-8", SCRIPT)),
            Some("/upload.css") => Some(("text/css; charset=utf-8", CSS)),
            Some("/health") if mode == "internet" => return Ok(respond(200, "text/plain", session.probe.clone())),
            _ => None,
        };
        if let Some((mime, body)) = static_file {
            return Ok(respond(200, mime, body));
        }
    }
    if header(&req, "sec-fetch-site") == Some("cross-site") {
        return Ok(respond(403, "text/plain", "Invalid request origin"));
    }
    let (status, body) = match route(session, req, mode).await {
        Ok(body) => (200, body),
        Err((status, message)) => (status, json!({"error":message})),
    };
    Ok(respond(status, "application/json", body.to_string()))
}

fn error(code: u16, text: &str) -> (u16, String) {
    (code, text.into())
}
fn disk(error: std::io::Error) -> (u16, String) {
    (507, format!("Could not write to the desktop inbox. {error}"))
}

async fn body(req: Request<Incoming>, limit: usize) -> std::result::Result<Bytes, (u16, String)> {
    let data = tokio::time::timeout(Duration::from_secs(10), Limited::new(req.into_body(), limit).collect())
        .await
        .map_err(|_| error(408, "The connection ended before the data arrived."))?
        .map_err(|e| if e.is::<http_body_util::LengthLimitError>() { error(413, "This request is too large.") } else { error(408, "The connection ended before the data arrived.") })?;
    Ok(data.to_bytes())
}

async fn route(session: Arc<Session>, req: Request<Incoming>, mode: &'static str) -> Http {
    let auth = header(&req, "authorization").and_then(|value| value.strip_prefix("Bearer ")).ok_or_else(|| error(401, "Scan the QR code on your desktop."))?;
    let method = req.method().clone();
    let target = req.uri().path_and_query().map_or("", |url| url.as_str()).to_owned();
    if method == Method::POST && target == "/pair" {
        if auth != session.key || session.started.elapsed() >= PAIR_TIME {
            return Err(error(410, "This pairing code expired. Scan a new QR code."));
        }
        let client: String = serde_json::from_slice(&body(req, 128).await?).map_err(|_| error(400, "Invalid pairing request."))?;
        if client.len() != 32 || !client.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error(400, "Invalid pairing request."));
        }
        let mut state = session.state.lock().unwrap();
        if session.expired() {
            return Err(error(410, "This session ended. Scan a new QR code."));
        }
        if state.phone.as_ref().is_some_and(|p| p.status == "denied" && p.client != client) {
            state.phone = None;
        }
        let phone = state.phone.get_or_insert_with(|| Phone { client: client.clone(), ticket: secret(), code: id()[..6].to_ascii_uppercase(), mode, status: "pending", seen: Instant::now() });
        if phone.client != client {
            return Err(error(409, "Another phone is already using this session."));
        }
        return Ok(json!({"ticket":phone.ticket,"code":phone.code,"status":phone.status}));
    }
    {
        let mut state = session.state.lock().unwrap();
        let phone = state.phone.as_mut().filter(|p| p.ticket == auth).ok_or_else(|| error(401, "Scan the QR code again."))?;
        phone.seen = Instant::now();
        phone.mode = mode;
        if method == Method::GET && target == "/status" {
            return Ok(json!({"status":phone.status,"code":phone.code,"mode":mode}));
        }
        if phone.status != "approved" {
            return Err(error(403, "Approve this phone on the desktop first."));
        }
    }
    let data = match method {
        Method::POST if target == "/files" => body(req, 2048).await?,
        Method::PUT if target.starts_with("/files/") => body(req, CHUNK).await?,
        _ => Bytes::new(),
    };
    tauri::async_runtime::spawn_blocking(move || file_request(&session, method, &target, &data)).await.map_err(|_| error(500, "The desktop could not process the upload."))?
}

fn file_request(session: &Session, method: Method, target: &str, data: &[u8]) -> Http {
    if session.expired() {
        return Err(error(410, "This session ended. Scan a new QR code."));
    }
    if method == Method::POST && target == "/files" {
        let mut info: FileInfo = serde_json::from_slice(data).map_err(|_| error(400, "Invalid file information."))?;
        info.name = safe_name(&info.name).ok_or_else(|| error(415, "Choose a supported profile, plugin, image or configuration file."))?;
        if info.digest.len() != 64 || !info.digest.bytes().all(|b| b.is_ascii_hexdigit()) || info.size == 0 || info.size > FILE_LIMIT {
            return Err(error(400, "Files must be between 1 byte and 300 MB."));
        }
        info.digest.make_ascii_lowercase();
        let mut state = session.state.lock().unwrap();
        if session.expired() {
            return Err(error(410, "This session ended. Scan a new QR code."));
        }
        if let Some(previous) = state.files.iter().find(|f| f.info.size == info.size && f.info.digest == info.digest) {
            return Ok(previous.summary());
        }
        if state.files.len() >= FILE_COUNT || state.files.iter().map(|f| f.info.size).sum::<u64>() + info.size > TOTAL_LIMIT {
            return Err(error(413, "This session reached its file limit."));
        }
        fs::create_dir_all(&session.folder).map_err(disk)?;
        let id = id();
        let path = session.folder.join(format!("{id}.part"));
        fs::File::create_new(&path).map_err(disk)?;
        let now = Instant::now();
        let kind = file_kind(&info.name, &path, false);
        let file = File { id, info, path, received: 0, complete: false, kind, started: now, last: now, checked: Sha256::new() };
        let summary = file.summary();
        state.files.push(file);
        return Ok(summary);
    }
    let Some(file) = target.strip_prefix("/files/") else {
        return Err(error(404, "This page was not found."));
    };
    let (file, offset) = file.split_once("?offset=").map_or((file, None), |(f, o)| (f, o.parse::<u64>().ok()));
    if method == Method::DELETE {
        session.cancel(file).map_err(|e| (409, e))?;
        return Ok(json!({"cancelled":true}));
    }
    let mut state = session.state.lock().unwrap();
    let item = state.files.iter_mut().find(|f| f.id == file).ok_or_else(|| error(404, "This upload was cancelled."))?;
    if method == Method::GET || item.complete {
        return Ok(item.summary());
    }
    if method != Method::PUT || offset != Some(item.received) {
        return Err(error(409, "The saved offset changed. Resume the upload."));
    }
    if session.expired() {
        return Err(error(410, "This session ended. Scan a new QR code."));
    }
    if data.is_empty() || item.received + data.len() as u64 > item.info.size {
        return Err(error(400, "Invalid chunk length."));
    }
    let mut out = fs::OpenOptions::new().append(true).open(&item.path).map_err(disk)?;
    if let Err(e) = out.write_all(data) {
        let _ = out.set_len(item.received);
        return Err(disk(e));
    }
    if item.received + data.len() as u64 == item.info.size
        && let Err(e) = out.sync_all()
    {
        let _ = out.set_len(item.received);
        return Err(disk(e));
    }
    drop(out);
    let mut hash = item.checked.clone();
    hash.update(data);
    if item.received + data.len() as u64 == item.info.size {
        let digest = hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
        if digest != item.info.digest {
            fs::File::create(&item.path).map_err(disk)?;
            item.received = 0;
            item.checked = Sha256::new();
            return Err(error(422, "The file failed integrity verification. Try again."));
        }
        let ready = session.folder.join(&item.id);
        let destination = ready.join(&item.info.name);
        if let Err(e) = fs::create_dir_all(&ready).and_then(|()| fs::rename(&item.path, &destination)) {
            let _ = fs::OpenOptions::new().write(true).open(&item.path).and_then(|f| f.set_len(item.received));
            return Err(disk(e));
        }
        item.path = destination;
        item.complete = true;
        item.kind = file_kind(&item.info.name, &item.path, true);
    } else {
        item.checked = hash;
    }
    item.received += data.len() as u64;
    item.last = Instant::now();
    Ok(item.summary())
}

fn safe_name(name: &str) -> Option<String> {
    let name = name.rsplit(['/', '\\']).next()?.trim();
    if name.is_empty() || name.len() > 170 || name.starts_with('.') || name.ends_with('.') || name.chars().any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return None;
    }
    let stem = name.split('.').next()?.trim_end().to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem[3..].parse::<u8>().is_ok()) {
        return None;
    }
    let extension = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "masterdeck" | "hubdeck" | "mhz" | "streamdeckplugin" | "zip" | "streamdeckiconpack" | "jpg" | "jpeg" | "png" | "gif" | "webp" | "json" | "yaml" | "yml" | "toml" | "ini"
    )
    .then(|| name.into())
}

fn file_kind(name: &str, path: &Path, done: bool) -> &'static str {
    let extension = Path::new(name).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "hubdeck" | "masterdeck" | "mhz" => "profile",
        "streamdeckplugin" | "zip" => "plugin",
        "streamdeckiconpack" => "icons",
        "json"
            if done
                && fs::metadata(path).is_ok_and(|m| m.len() < 4 * 1024 * 1024)
                && fs::read(path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v| v["controls"].is_object() && v["name"].is_string()) =>
        {
            "profile"
        }
        _ => "file",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpStream};

    #[test]
    fn approved_phone_can_resume_and_verify_a_file() {
        let server = listener(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let addr = server.local_addr().unwrap();
        let session = Arc::new(Session {
            key: secret(),
            started: Instant::now(),
            probe: id(),
            folder: std::env::temp_dir().join(format!("masterdeck-phone-{}", id())),
            closed: AtomicBool::new(false),
            local: None,
            remote: Mutex::new((None, String::new())),
            state: Mutex::new(Inner::default()),
        });
        serve(server, session.clone(), addr.to_string(), "local");
        let call = |method: &str, path: &str, auth: &str, body: &[u8]| -> (u16, Value) {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
            write!(stream, "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {auth}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n", body.len()).unwrap();
            stream.write_all(body).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            let (headers, body) = response.split_once("\r\n\r\n").unwrap();
            let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
            (status, serde_json::from_str(body).unwrap())
        };
        let empty = b"{}";
        assert_eq!(call("POST", "/files", "no-ticket", empty).0, 401);
        let (status, pair) = call("POST", "/pair", &session.key, serde_json::to_string(&id()).unwrap().as_bytes());
        assert_eq!(status, 200);
        let ticket = pair["ticket"].as_str().unwrap();
        assert_eq!(call("POST", "/files", ticket, empty).0, 403);
        session.state.lock().unwrap().phone.as_mut().unwrap().status = "approved";
        assert_eq!(call("GET", "/status", ticket, b"").1["status"], "approved");
        let content = br#"{"name":"Phone profile","controls":{}}"#;
        let hash = Sha256::digest(content).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let manifest = json!({"name":"deck.json","size":content.len(),"digest":hash}).to_string();
        let (_, file) = call("POST", "/files", ticket, manifest.as_bytes());
        let id = file["id"].as_str().unwrap();
        assert_eq!(call("PUT", &format!("/files/{id}?offset=0"), ticket, &content[..10]).1["bytes"], 10);
        assert_eq!(call("PUT", &format!("/files/{id}?offset=4"), ticket, &content[10..]).0, 409);
        let resumed = call("POST", "/files", ticket, manifest.as_bytes()).1;
        assert_eq!(resumed["id"], id);
        assert_eq!(resumed["bytes"], 10);
        let checked = call("PUT", &format!("/files/{id}?offset=10"), ticket, &content[10..]);
        assert_eq!(checked.0, 200);
        assert_eq!(checked.1["kind"], "profile");
        assert_eq!(checked.1["complete"], true);
        assert_eq!(fs::read(session.folder.join(id).join("deck.json")).unwrap(), content);
        assert_eq!(call("POST", "/files", ticket, manifest.as_bytes()).1["id"], id);
        let broken = json!({"name":"test.toml","size":1,"digest":"0".repeat(64)}).to_string();
        let broken = call("POST", "/files", ticket, broken.as_bytes()).1;
        let broken = broken["id"].as_str().unwrap();
        assert_eq!(call("PUT", &format!("/files/{broken}?offset=0"), ticket, b"a").0, 422);
        assert_eq!(call("DELETE", &format!("/files/{broken}"), ticket, b"").0, 200);
        assert!(safe_name("CON.json").is_none() && safe_name("plugin.exe").is_none());
        session.close();
        fs::remove_dir_all(&session.folder).unwrap();
    }
}
