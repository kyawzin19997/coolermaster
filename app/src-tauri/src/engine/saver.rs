//! The screensaver (roadmap phase 12 G; the assistant's advice the owner passed on, 2026-10-12):
//! after some idle minutes a calm scene across all 15 keys, gone at the first touch, which only
//! wakes the deck. Mood when you are away, nothing moving while you work.

use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, RgbImage, RgbaImage};
use serde::{Deserialize, Serialize};

use super::{
    canvas,
    render::{self, PANEL_H, PANEL_W},
};

pub const JPEG_QUALITY: u8 = 90;
const MAX_BYTES: usize = 15 * 1024 * 1024;
const MAX_FRAMES: usize = 300;
const MAX_PIXELS: u64 = 120_000_000;
const MAX_DECODED_SIDE: u32 = 2048;
const MAX_ITEMS: usize = 24;
const MAX_PACKED_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CustomSaver {
    pub id: String,
    pub name: String,
    pub animated: bool,
}

fn custom_id(effect: &str) -> Option<&str> {
    effect.strip_prefix("custom:").filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn folder(data: &Path, effect: &str) -> Option<PathBuf> {
    Some(data.join("screensavers").join(custom_id(effect)?))
}

#[derive(Serialize, Deserialize)]
struct Index {
    ends: Vec<u64>,
}

pub struct Clip {
    directory: PathBuf,
    index: Index,
}

impl Clip {
    pub fn open(data: &Path, effect: &str) -> Option<Self> {
        let directory = folder(data, effect)?;
        let index: Index = serde_json::from_slice(&fs::read(directory.join("frames.json")).ok()?).ok()?;
        if index.ends.is_empty() || index.ends.len() > MAX_FRAMES || index.ends[0] == 0 || !index.ends.windows(2).all(|w| w[0] < w[1]) {
            return None;
        }
        Some(Self { directory, index })
    }

    pub fn frame_at(&self, elapsed: Duration) -> (usize, Option<Duration>) {
        if self.index.ends.len() == 1 {
            return (0, None);
        }
        let cycle = self.index.ends[self.index.ends.len() - 1];
        let position = (elapsed.as_millis() % u128::from(cycle)) as u64;
        let frame = self.index.ends.partition_point(|end| *end <= position);
        (frame, Some(Duration::from_millis(self.index.ends[frame] - position)))
    }

    pub fn jpeg(&self, rotation: i32, frame: usize) -> std::io::Result<Vec<u8>> {
        fs::read(self.directory.join(format!("{}-{frame}.jpg", rotation.div_euclid(90).rem_euclid(4))))
    }
}

enum Source {
    Scene(Box<canvas::Canvas>),
    Media(Clip),
    Black,
}

pub struct Playback {
    pub effect: String,
    pub next: Option<Instant>,
    pub sequence: u64,
    start: Instant,
    source: Source,
    frame: usize,
    picture: Option<(i32, Arc<[u8]>)>,
}

impl Playback {
    pub fn new(effect: String, data: &Path, effects: Option<super::profile::Effects>) -> Self {
        let source = if let Some(clip) = Clip::open(data, &effect) {
            Source::Media(clip)
        } else if let Some(canvas) = effects.as_ref().and_then(canvas::Canvas::new) {
            Source::Scene(Box::new(canvas))
        } else {
            Source::Black
        };
        let start = Instant::now();
        Self { effect, next: Some(start), sequence: 0, start, source, frame: 0, picture: None }
    }

    pub fn due(&self, now: Instant) -> bool {
        self.next.is_some_and(|at| at <= now)
    }

    pub fn picture(&mut self, now: Instant, rotation: i32, geometry: &render::PanelGeometry) -> Arc<[u8]> {
        let same_rotation = self.picture.as_ref().is_some_and(|(previous, _)| *previous == rotation);
        if same_rotation && !self.due(now) {
            return self.picture.as_ref().expect("cached screensaver frame").1.clone();
        }
        // Send at the deck's normal canvas rate. Pick media frames from elapsed time so a slow
        // draw or USB transfer can skip a frame without dragging out the whole animation.
        let step = super::CANVAS_EVERY;
        let result = match &mut self.source {
            Source::Scene(canvas) => {
                let places = std::array::from_fn::<_, 15, _>(|i| {
                    let (x, y, w, h) = geometry.key_rect(i);
                    canvas::KeyPlace { x, y, w, h }
                });
                let mut pixmap = blank_panel();
                let moving = canvas.step(&places, canvas::down_for(rotation));
                canvas.under(pixmap.data_mut());
                canvas.over(pixmap.data_mut());
                self.next = moving.then(|| self.next.map(|last| last + step).filter(|beat| *beat > now).unwrap_or(now + step));
                render::encode_jpeg(&pixmap, JPEG_QUALITY)
            }
            Source::Media(clip) => {
                let (frame, remaining) = clip.frame_at(now.saturating_duration_since(self.start));
                self.next = remaining.map(|delay| now + delay.max(step));
                if same_rotation && self.frame == frame {
                    return self.picture.as_ref().expect("cached media frame").1.clone();
                }
                self.frame = frame;
                clip.jpeg(rotation, frame).map_err(|e| e.to_string())
            }
            Source::Black => {
                self.next = None;
                let jpeg = black_jpeg();
                self.picture = Some((rotation, jpeg.clone()));
                return jpeg;
            }
        };
        let jpeg = match result {
            Ok(bytes) => Arc::from(bytes),
            Err(error) => {
                log::warn!("screensaver frame: {error}");
                self.next = None;
                black_jpeg()
            }
        };
        self.sequence += 1;
        self.picture = Some((rotation, jpeg.clone()));
        jpeg
    }
}

fn blank_panel() -> resvg::tiny_skia::Pixmap {
    let mut pixmap = resvg::tiny_skia::Pixmap::new(PANEL_W, PANEL_H).expect("nonempty key panel");
    pixmap.fill(resvg::tiny_skia::Color::BLACK);
    pixmap
}

pub fn black_jpeg() -> Arc<[u8]> {
    static JPEG: OnceLock<Arc<[u8]>> = OnceLock::new();
    JPEG.get_or_init(|| Arc::from(render::encode_jpeg(&blank_panel(), JPEG_QUALITY).expect("encode black key panel"))).clone()
}

fn limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODED_SIDE);
    limits.max_image_height = Some(MAX_DECODED_SIDE);
    limits.max_alloc = Some(32 * 1024 * 1024);
    limits
}

fn encode_frame(src: RgbaImage, directory: &Path, frame: usize) -> Result<usize, String> {
    let src = DynamicImage::ImageRgba8(src);
    let fit = |w, h| {
        let rgba = src.resize_to_fill(w, h, image::imageops::FilterType::Triangle).into_rgba8();
        RgbImage::from_fn(w, h, |x, y| {
            let [r, g, b, a] = rgba.get_pixel(x, y).0;
            image::Rgb([r, g, b].map(|c| (u16::from(c) * u16::from(a) / 255) as u8))
        })
    };
    let landscape = fit(PANEL_W, PANEL_H);
    let portrait = fit(PANEL_H, PANEL_W);
    let pictures = [landscape.clone(), image::imageops::rotate90(&portrait), image::imageops::rotate180(&landscape), image::imageops::rotate270(&portrait)];
    let mut size = 0;
    for (rotation, picture) in pictures.iter().enumerate() {
        let mut bytes = Vec::new();
        jpeg_encoder::Encoder::new(&mut bytes, JPEG_QUALITY).encode(picture.as_raw(), PANEL_W as u16, PANEL_H as u16, jpeg_encoder::ColorType::Rgb).map_err(|e| e.to_string())?;
        size += bytes.len();
        fs::write(directory.join(format!("{rotation}-{frame}.jpg")), bytes).map_err(|e| e.to_string())?;
    }
    Ok(size)
}

fn prepare(bytes: &[u8], directory: &Path) -> Result<bool, String> {
    let format = image::guess_format(bytes).map_err(|_| "Choose a GIF, PNG, JPEG or WebP image.")?;
    let mut index = Index { ends: Vec::new() };
    let mut pixels = 0;
    let mut packed = 0;
    let mut add = |frame: RgbaImage, duration: u64| -> Result<(), String> {
        pixels += u64::from(frame.width()) * u64::from(frame.height());
        if index.ends.len() == MAX_FRAMES || pixels > MAX_PIXELS {
            return Err("This animation is too long or large. Choose a shorter animation or reduce its dimensions.".into());
        }
        packed += encode_frame(frame, directory, index.ends.len())?;
        if packed > MAX_PACKED_BYTES {
            return Err("This animation is too large after preparation. Choose a shorter animation.".into());
        }
        index.ends.push(index.ends.last().unwrap_or(&0) + duration);
        Ok(())
    };
    let error = |e: image::ImageError| format!("Could not read the image: {e}");
    let frames = match format {
        ImageFormat::Gif => {
            let mut decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).map_err(error)?;
            decoder.set_limits(limits()).map_err(error)?;
            Some(decoder.into_frames())
        }
        ImageFormat::WebP => {
            let mut decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).map_err(error)?;
            decoder.set_limits(limits()).map_err(error)?;
            decoder.has_animation().then(|| decoder.into_frames())
        }
        ImageFormat::Png | ImageFormat::Jpeg => None,
        _ => return Err("Choose a GIF, PNG, JPEG or WebP image.".into()),
    };
    if let Some(frames) = frames {
        for frame in frames {
            let frame = frame.map_err(error)?;
            let (num, den) = frame.delay().numer_denom_ms();
            let delay = u64::from(num.checked_div(den).unwrap_or(0));
            add(frame.into_buffer(), if delay <= 10 { 100 } else { delay })?;
        }
    } else {
        let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
        reader.limits(limits());
        add(reader.decode().map_err(error)?.into_rgba8(), 100)?;
    }
    if index.ends.is_empty() {
        return Err("The animation contains no readable frames.".into());
    }
    fs::write(directory.join("frames.json"), serde_json::to_vec(&index).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(index.ends.len() > 1)
}

#[tauri::command]
pub fn savers_list(engine: tauri::State<'_, super::Engine>) -> Vec<CustomSaver> {
    engine.lock().store.settings.custom_savers.clone()
}

#[tauri::command]
pub async fn saver_import(app: tauri::AppHandle, path: String) -> Result<CustomSaver, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let engine = app.state::<super::Engine>();
        let src = Path::new(&path);
        let file = fs::File::open(src).map_err(|e| format!("Could not open the image: {e}"))?;
        let size = file.metadata().map_err(|e| e.to_string())?;
        if !size.is_file() || size.len() == 0 || size.len() > MAX_BYTES as u64 {
            return Err("Choose a nonempty image up to 15 MB.".into());
        }
        if engine.lock().store.settings.custom_savers.len() >= MAX_ITEMS {
            return Err("You can keep up to 24 custom screensavers. Remove one before adding another.".into());
        }
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("Choose a nonempty image up to 15 MB.".into());
        }
        let id = format!("custom:{}", uuid::Uuid::new_v4().simple());
        let directory = folder(engine.data_dir(), &id).expect("generated screensaver id");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let result = (|| {
            let animated = prepare(&bytes, &directory)?;
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("Custom screensaver");
            let name: String = stem.trim().chars().filter(|c| !c.is_control()).take(80).collect();
            let media = CustomSaver { id, name: if name.is_empty() { "Custom screensaver".into() } else { name }, animated };
            let mut shared = engine.lock();
            if shared.store.settings.custom_savers.len() >= MAX_ITEMS {
                return Err("You can keep up to 24 custom screensavers. Remove one before adding another.".into());
            }
            shared.store.settings.custom_savers.push(media.clone());
            if let Err(error) = shared.store.save_settings() {
                shared.store.settings.custom_savers.pop();
                return Err(error.to_string());
            }
            Ok(media)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(directory);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn saver_remove(engine: tauri::State<'_, super::Engine>, id: String) -> Result<(), String> {
    let directory = folder(engine.data_dir(), &id).ok_or("Invalid screensaver.")?;
    {
        let mut shared = engine.lock();
        let Some(index) = shared.store.settings.custom_savers.iter().position(|item| item.id == id) else { return Ok(()) };
        let old = shared.store.settings.clone();
        shared.store.settings.custom_savers.remove(index);
        if shared.store.settings.saver == id {
            shared.store.settings.saver.clear();
        }
        if let Err(error) = shared.store.save_settings() {
            shared.store.settings = old;
            return Err(error.to_string());
        }
        if shared.saver_preview.as_ref().is_some_and(|(effect, _)| *effect == id) {
            shared.saver_preview = None;
        }
    }
    if let Err(error) = fs::remove_dir_all(directory)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        log::warn!("could not remove unused screensaver files: {error}");
    }
    let _ = engine.sender().send(super::Msg::SaverChanged);
    Ok(())
}

#[tauri::command]
pub fn saver_configure(engine: tauri::State<'_, super::Engine>, profile: Option<String>, saver: Option<super::profile::ProfileSaver>) -> Result<(), String> {
    {
        let mut shared = engine.lock();
        let mut saver = saver;
        if let Some(choice) = &mut saver {
            if !choice.effect.is_empty() && !shared.knows_saver(&choice.effect) {
                return Err("This screensaver is unavailable.".into());
            }
            choice.after_minutes = choice.after_minutes.map(|minutes| minutes.clamp(1, 240));
            choice.layers = choice.layers.take().filter(|_| preset(&choice.effect).is_some());
        }
        if let Some(id) = profile {
            let mut profile = shared.store.profiles.get(&id).cloned().ok_or("The profile is unavailable.")?;
            profile.saver = saver;
            shared.store.save_profile(profile).map_err(|e| e.to_string())?;
        } else {
            let choice = saver.unwrap_or_default();
            let old = shared.store.settings.clone();
            let settings = &mut shared.store.settings;
            settings.saver = choice.effect;
            settings.saver_layers = choice.layers;
            if let Some(minutes) = choice.after_minutes {
                settings.saver_after_minutes = minutes;
            }
            if let Err(error) = shared.store.save_settings() {
                shared.store.settings = old;
                return Err(error.to_string());
            }
        }
        shared.saver_preview = None;
    }
    engine.changed();
    let _ = engine.sender().send(super::Msg::SaverChanged);
    Ok(())
}
/// The scenes: the living deck's layers across all 15 keys, made for a deck nobody touches
/// (owner, 2026-10-26: "jakieś wow, takie bardzo wysokiej jakości wygaszacza"). Each with the colour
/// the dial and the lights take while it runs. The drawn effects (code rain, night sky, waves) and
/// the big clock are gone (owner, 2026-10-30: "cdoe rain, nioght sky, waves, big clock do usuniecia").
pub const SCENES: [(&str, &str); 8] =
    [("aurora", "#3ee6a8"), ("aquarium", "#2aa8e0"), ("lava", "#ff5a2a"), ("fire", "#ff8a1e"), ("snowfall", "#b8d4ff"), ("fireflies", "#d8e860"), ("neon", "#ff3aa8"), ("haunted", "#9a6ae0")];

/// Scenes kept for their season but not offered: not in "Next", not in the key's list (owner,
/// 2026-10-30: "snowy night schowaj - przywrócimy na zimę"). One already chosen keeps running.
pub const HIDDEN: [&str; 1] = ["snowfall"];

/// The screensavers taken out, and the scene a setting that still names one gets instead.
const GONE: [&str; 4] = ["rain", "stars", "waves", "clock"];
const INSTEAD: &str = "aurora";

/// A saved screensaver as it runs today: one taken out becomes the aurora.
pub fn current(id: &str) -> String {
    if GONE.contains(&id) { INSTEAD.to_string() } else { id.to_string() }
}

/// A preset as the screensaver (owner, 2026-10-30: "presety dorzucamy jako screensavery tez"):
/// `FROM_LOOK` is the profile's own look from Deck look, `preset:<id>` a preset whose layers come
/// with it (the window knows the presets).
pub const FROM_LOOK: &str = "preset";

/// The preset `id` names: Some("") for the profile's own look, Some(<id>) for a preset.
pub fn preset(id: &str) -> Option<&str> {
    if id == FROM_LOOK { Some("") } else { id.strip_prefix("preset:").filter(|p| !p.is_empty()) }
}

/// Whether `id` is a screensaver (a scene, a taken-out one that maps to a scene, or a preset).
pub fn known(id: &str) -> bool {
    let id = current(id);
    preset(&id).is_some() || SCENES.iter().any(|(s, _)| *s == id)
}

/// A preset's layers as a screensaver: the same picture without its answer to presses (the first
/// touch only wakes the deck).
pub fn still(fx: &super::profile::Effects) -> super::profile::Effects {
    let mut out = fx.clone();
    for l in &mut out.layers {
        l.react = Some(false);
    }
    out
}

/// The layers of scene `id`, drawn by the living deck's canvas on black keys; None for anything else.
pub fn scene(id: &str) -> Option<super::profile::Effects> {
    use super::profile::{Effects, Layer};
    let l = |kind: &str| Layer { kind: kind.into(), react: Some(false), ..Layer::default() };
    let layers = match id {
        // the northern lights over a starry night sky
        "aurora" => vec![Layer { density: Some(60), ..l("scene") }, Layer { strength: Some(85), ..l("aurora") }],
        // koi in clear water, the light of the surface on the bottom
        "aquarium" => vec![l("aquarium"), Layer { strength: Some(45), ..l("caustics") }],
        "lava" => vec![Layer { strength: Some(80), ..l("lava") }],
        // a fire along the bottom, embers rising out of it
        "fire" => vec![Layer { strength: Some(80), ..l("fire") }, Layer { density: Some(60), ..l("embers") }],
        "snowfall" => vec![Layer { tint: Some("#1c2a48".into()), density: Some(40), ..l("scene") }, Layer { density: Some(65), ..l("snow") }],
        "fireflies" => vec![Layer { tint: Some("#14301c".into()), density: Some(30), ..l("scene") }, Layer { density: Some(70), ..l("fireflies") }],
        "neon" => vec![Layer { strength: Some(80), ..l("neonrain") }, Layer { tint: Some("#7a3ad0".into()), strength: Some(35), density: Some(30), ..l("mist") }],
        // Halloween's haunted night without its presses
        "haunted" => vec![
            Layer { tint: Some("#6a3aa0".into()), density: Some(45), ..l("scene") },
            l("haunt"),
            Layer { tint: Some("#9a7ae0".into()), strength: Some(50), density: Some(30), wind: Some(15), ..l("mist") },
            l("bats"),
            l("ghost"),
        ],
        _ => return None,
    };
    Some(Effects { layers, ..Effects::default() })
}

/// The colour of `id` for the dial and the lights; None = the deck's light colour.
pub fn color(id: &str) -> Option<&'static str> {
    SCENES.iter().find(|(s, _)| *s == id).map(|(_, c)| *c).filter(|c| !c.is_empty())
}

/// Seconds since the app's clock started (the weather dial and the nudges move with it).
pub fn clock() -> f32 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f32()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_and_loops_an_animated_image() {
        let id = format!("custom:{}", uuid::Uuid::new_v4().simple());
        let data = std::env::temp_dir().join(custom_id(&id).unwrap());
        let directory = folder(&data, &id).unwrap();
        fs::create_dir_all(&directory).unwrap();
        let mut gif = Vec::new();
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut gif);
        for (rgba, duration) in [([220, 30, 30, 255], 80), ([30, 30, 220, 255], 120)] {
            let pixels = RgbaImage::from_pixel(12, 8, image::Rgba(rgba));
            encoder.encode_frame(image::Frame::from_parts(pixels, 0, 0, image::Delay::from_numer_denom_ms(duration, 1))).unwrap();
        }
        drop(encoder);
        assert!(prepare(&gif, &directory).unwrap());
        let clip = Clip::open(&data, &id).unwrap();
        assert_eq!(clip.frame_at(Duration::from_millis(79)), (0, Some(Duration::from_millis(1))));
        assert_eq!(clip.frame_at(Duration::from_millis(80)), (1, Some(Duration::from_millis(120))));
        assert_eq!(clip.frame_at(Duration::from_millis(200)), (0, Some(Duration::from_millis(80))));
        for rotation in [0, 90, 180, 270] {
            for frame in 0..2 {
                let rgb = image::load_from_memory(&clip.jpeg(rotation, frame).unwrap()).unwrap().into_rgb8();
                assert_eq!(rgb.dimensions(), (PANEL_W, PANEL_H));
                let [red, _, blue] = rgb.get_pixel(PANEL_W / 2, PANEL_H / 2).0;
                assert_eq!(red > blue, frame == 0);
            }
        }
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn a_built_in_scene_schedules_its_own_frames() {
        let mut playback = Playback::new("aurora".into(), Path::new("."), scene("aurora"));
        let first = playback.next.unwrap();
        let one = playback.picture(first, 0, &render::PanelGeometry::default());
        let next = playback.next.expect("the scene schedules animation without an active profile or key");
        assert!(next > first && !playback.due(first) && playback.due(next));
        let two = playback.picture(next, 0, &render::PanelGeometry::default());
        assert_ne!(one, two);
    }

    #[test]
    fn every_scene_is_known_layers() {
        for (id, _) in SCENES {
            assert!(known(id));
            let fx = scene(id).expect("a scene has layers");
            assert!(fx.active(), "{id} has layers");
            for l in fx.stack() {
                assert!(super::super::canvas::KINDS.contains(&l.kind.as_str()), "{id}: {} is a layer", l.kind);
            }
        }
        assert!(!known("nope") && scene("nope").is_none());
    }

    #[test]
    fn the_ones_taken_out_become_the_aurora() {
        for id in ["rain", "stars", "waves", "clock"] {
            assert!(known(id));
            assert_eq!(current(id), "aurora");
        }
        assert_eq!(current("lava"), "lava");
    }

    #[test]
    fn presets_are_screensavers_that_do_not_answer_presses() {
        assert!(known(FROM_LOOK) && known("preset:japan-koi") && !known("preset:"));
        assert_eq!(preset("preset:japan-koi"), Some("japan-koi"));
        assert_eq!(preset(FROM_LOOK), Some(""));
        assert_eq!(preset("aurora"), None);
        let fx = super::super::profile::Effects { layers: vec![super::super::profile::Layer { kind: "koi".into(), ..Default::default() }], ..Default::default() };
        assert!(still(&fx).layers.iter().all(|l| l.react == Some(false)));
    }
}
