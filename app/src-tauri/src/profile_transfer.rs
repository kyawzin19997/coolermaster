//! Short-lived, read-only profile downloads and native file sharing.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use http_body_util::Full;
use hyper::{
    Method, Request, Response,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::{
    engine::{Engine, share},
    phone_upload,
};

const LINK_LIFE: Duration = Duration::from_secs(600);
const CACHE_LIFE: Duration = Duration::from_secs(86400);

#[derive(Default)]
pub struct ProfileTransfers(Mutex<Option<Weak<Download>>>);

struct Download {
    key: String,
    host: String,
    file: Bytes,
    name: String,
    expires: Instant,
    stopped: AtomicBool,
}

impl Download {
    fn active(&self) -> bool {
        !self.stopped.load(Ordering::Acquire) && Instant::now() < self.expires
    }

    fn response(&self, method: &Method, host: Option<&str>, path: &str) -> Response<Full<Bytes>> {
        let (status, body, file) = if host != Some(self.host.as_str()) || path.strip_prefix("/profile/") != Some(self.key.as_str()) {
            (404, Bytes::from_static(b"Profile link unavailable."), false)
        } else if !self.active() {
            (410, Bytes::from_static(b"This profile link expired. Ask for a new link."), false)
        } else if method == Method::GET || method == Method::HEAD {
            (200, if method == Method::GET { self.file.clone() } else { Bytes::new() }, true)
        } else {
            (405, Bytes::new(), false)
        };
        let mut response = Response::builder()
            .status(status)
            .header("Cache-Control", "no-store")
            .header("Referrer-Policy", "no-referrer")
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        if file {
            response =
                response.header("Content-Type", "application/octet-stream").header("Content-Disposition", format!("attachment; filename=\"{}\"", self.name)).header("Content-Length", self.file.len());
        } else {
            response = response.header("Content-Type", "text/plain; charset=utf-8");
        }
        response.body(Full::new(body)).expect("validated HTTP response")
    }
}

fn filename(name: &str) -> String {
    let clean: String = name.chars().take(80).map(|c| if c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-') { c } else { '-' }).collect();
    let clean = clean.trim_matches([' ', '-']);
    format!("{}.{}", if clean.is_empty() { "MasterDeck Profile" } else { clean }, share::EXT)
}

#[derive(Serialize)]
pub struct DownloadLink {
    url: String,
    qr: String,
    seconds: u64,
}

#[tauri::command]
pub async fn profile_share_link(app: AppHandle, id: String) -> Result<DownloadLink, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ip = phone_upload::lan_ip().ok_or("Connect this computer and the receiving device to the same Wi-Fi network.")?;
        let server = phone_upload::listener((ip, 0).into()).map_err(|e| format!("Could not start the local download: {e}"))?;
        let host = server.local_addr().map_err(|e| e.to_string())?.to_string();
        let engine = app.state::<Engine>();
        let name = profile_name(&engine, &id)?;
        let file = Bytes::from(share::package_bytes(&engine, &id)?);
        let key = phone_upload::secret();
        let url = format!("http://{host}/profile/{key}");
        let qr = phone_upload::qr_svg(&url)?;
        let session = Arc::new(Download { key, host, file, name: filename(&name), expires: Instant::now() + LINK_LIFE, stopped: AtomicBool::new(false) });
        if let Some(old) = app.state::<ProfileTransfers>().0.lock().unwrap().replace(Arc::downgrade(&session)).and_then(|old| old.upgrade()) {
            old.stopped.store(true, Ordering::Release);
        }
        serve(server, session);
        Ok(DownloadLink { url, qr, seconds: LINK_LIFE.as_secs() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn profile_share_stop(transfers: State<'_, ProfileTransfers>) {
    if let Some(session) = transfers.0.lock().unwrap().take().and_then(|session| session.upgrade()) {
        session.stopped.store(true, Ordering::Release);
    }
}

fn serve(listener: std::net::TcpListener, session: Arc<Download>) {
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        let permits = Arc::new(tokio::sync::Semaphore::new(8));
        while session.active() {
            let Ok(result) = tokio::time::timeout(Duration::from_millis(250), listener.accept()).await else { continue };
            let Ok((stream, _)) = result else { break };
            let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
            let session = session.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let handler = service_fn(move |request: Request<Incoming>| {
                    let host = request.headers().get("host").and_then(|value| value.to_str().ok());
                    let response = session.response(request.method(), host, request.uri().path());
                    async { Ok::<_, std::convert::Infallible>(response) }
                });
                let connection = http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(5)).keep_alive(false).serve_connection(TokioIo::new(stream), handler);
                let _ = tokio::time::timeout(Duration::from_secs(90), connection).await;
            });
        }
    });
}

fn profile_name(engine: &Engine, id: &str) -> Result<String, String> {
    engine.lock().store.profiles.get(id).map(|p| p.name.clone()).ok_or_else(|| "This profile is no longer available.".into())
}

fn export_for_share(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let engine = app.state::<Engine>();
    let name = profile_name(&engine, id)?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("shared-profiles");
    if let Ok(entries) = fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let stale = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > CACHE_LIFE);
            if stale && entry.file_name().to_str().is_some_and(|name| uuid::Uuid::parse_str(name).is_ok()) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let folder = cache.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file = folder.join(filename(&name));
    share::export_package(&engine, id, &file)?;
    Ok(file)
}

#[tauri::command]
pub async fn profile_share_native(window: WebviewWindow, id: String) -> Result<(), String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("System sharing is unavailable. Export the profile or share it with a QR code.".into());
    }
    let app = window.app_handle().clone();
    let file = tauri::async_runtime::spawn_blocking(move || export_for_share(&app, &id)).await.map_err(|e| e.to_string())??;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(native_share(&owner, &file));
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[cfg(not(any(windows, target_os = "macos")))]
fn native_share(_: &WebviewWindow, _: &Path) -> Result<(), String> {
    Err("System sharing is unavailable.".into())
}

#[cfg(windows)]
fn native_share(window: &WebviewWindow, file: &Path) -> Result<(), String> {
    use std::cell::RefCell;
    use windows::{
        ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager},
        Foundation::TypedEventHandler,
        Storage::{IStorageItem, StorageFile},
        Win32::UI::Shell::IDataTransferManagerInterop,
        core::{HSTRING, Interface},
    };
    thread_local! { static REQUEST: RefCell<Option<(DataTransferManager, i64)>> = const { RefCell::new(None) }; }
    let share = || -> windows::core::Result<()> {
        let owner = window.hwnd().map_err(|e| windows::core::Error::new(windows::core::HRESULT(0x80004005_u32 as i32), e.to_string()))?;
        let bridge = windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>()?;
        let manager: DataTransferManager = unsafe { bridge.GetForWindow(owner)? };
        REQUEST.with_borrow_mut(|previous| {
            if let Some((manager, token)) = previous.take() {
                let _ = manager.RemoveDataRequested(token);
            }
        });
        let path = HSTRING::from(file.as_os_str());
        let token = manager.DataRequested(&TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |_, args| {
            let request = args.ok()?.Request()?;
            let deferral = request.GetDeferral()?;
            let operation = StorageFile::GetFileFromPathAsync(&path);
            tauri::async_runtime::spawn(async move {
                let result = async {
                    let item: IStorageItem = operation?.await?.cast()?;
                    let data = request.Data()?;
                    data.Properties()?.SetTitle(&HSTRING::from("MasterDeck Profile"))?;
                    data.SetStorageItemsReadOnly(&windows_collections::IIterable::<IStorageItem>::from(vec![Some(item)]))
                }
                .await;
                if result.is_err() {
                    let _ = request.FailWithDisplayText(&HSTRING::from("Could not attach the profile. Export the file from MasterDeck and try again."));
                }
                let _ = deferral.Complete();
            });
            Ok(())
        }))?;
        if let Err(error) = unsafe { bridge.ShowShareUIForWindow(owner) } {
            let _ = manager.RemoveDataRequested(token);
            return Err(error);
        }
        REQUEST.with_borrow_mut(|entry| *entry = Some((manager, token)));
        Ok(())
    };
    share().map_err(|e| format!("Could not open Windows sharing: {e}"))
}

#[cfg(target_os = "macos")]
fn native_share(window: &WebviewWindow, file: &Path) -> Result<(), String> {
    use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{NSSharingServicePicker, NSWindow};
    use objc2_foundation::{NSArray, NSRect, NSRectEdge, NSString, NSURL};
    use std::cell::RefCell;
    thread_local! { static PICKER: RefCell<Option<Retained<NSSharingServicePicker>>> = const { RefCell::new(None) }; }
    let marker = MainThreadMarker::new().ok_or("Mac sharing requires the main window.")?;
    let window = window.ns_window().map_err(|e| e.to_string())?;
    // The Tauri window owns the NSWindow during this main-thread call.
    let view = unsafe { &*window.cast::<NSWindow>() }.contentView().ok_or("The Mac window is not available.")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy()));
    let items = NSArray::<AnyObject>::from_slice(&[&url]);
    // The picker remains alive while the system's share popover is open.
    // NSURL implements NSPasteboardWriting and represents the exported profile file.
    let picker = unsafe { NSSharingServicePicker::initWithItems(marker.alloc(), &items) };
    picker.showRelativeToRect_ofView_preferredEdge(NSRect::ZERO, &view, NSRectEdge::MinY);
    PICKER.with_borrow_mut(|current| *current = Some(picker));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_checks_its_token_host_method_and_lifetime() {
        let session = Download {
            key: "secret".into(),
            host: "127.0.0.1:4567".into(),
            file: Bytes::from_static(b"profile"),
            name: filename("Example"),
            expires: Instant::now() + LINK_LIFE,
            stopped: AtomicBool::new(false),
        };
        let host = Some(session.host.as_str());
        let path = "/profile/secret";
        assert_eq!(session.response(&Method::GET, host, "/profile/other").status(), 404);
        assert_eq!(session.response(&Method::GET, Some("other"), path).status(), 404);
        assert_eq!(session.response(&Method::POST, host, path).status(), 405);
        assert_eq!(session.response(&Method::HEAD, host, path).headers()["content-length"], "7");
        let response = session.response(&Method::GET, host, path);
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-disposition"], "attachment; filename=\"Example.masterdeck\"");
        session.stopped.store(true, Ordering::Release);
        assert_eq!(session.response(&Method::GET, host, path).status(), 410);
    }
}
