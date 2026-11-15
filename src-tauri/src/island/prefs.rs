//! Nova Island's preferences: what Island Studio sets and the island draws from.
//!
//! Rust is the source of truth. Whatever comes in, from the database or from the
//! Studio's page, goes through `sanitized`: every number is clamped, every color
//! checked, the module order completed. The page mirrors these types in
//! src/features/island/types.ts; `default-prefs.json` there is tested against
//! `IslandPrefs::default()` from both sides, so the defaults can't drift apart.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IslandTheme {
    #[default]
    Black,
    White,
    Glass,
    /// The material from `IslandLook`: background, opacity, veil, rim and shadow.
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IslandMode {
    /// The NOVA dot stays where it is, beside the island.
    #[default]
    DotAndIsland,
    /// The dot lives inside the island; its own window goes away.
    IslandOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IslandAnchor {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IslandBorder {
    Off,
    #[default]
    Fine,
    Glow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MotionStyle {
    #[default]
    Springy,
    Soft,
    Minimal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandModules {
    pub music: bool,
    pub notifications: bool,
    pub calls: bool,
    pub system: bool,
    pub ai: bool,
}

impl Default for IslandModules {
    fn default() -> Self {
        Self { music: true, notifications: true, calls: true, system: false, ai: true }
    }
}

/// A module by name, for the order they rank in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModuleKey {
    Calls,
    Ai,
    Notifications,
    Music,
    System,
}

impl ModuleKey {
    /// The ranking NOVA ships with: a call, NOVA AI, a notification, music, the system.
    pub const DEFAULT_ORDER: [ModuleKey; 5] = [ModuleKey::Calls, ModuleKey::Ai, ModuleKey::Notifications, ModuleKey::Music, ModuleKey::System];
}

/// What the closed pill can carry at one of its ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotItem {
    Cover,
    Visualizer,
    AppIcon,
    Clock,
    Remaining,
    Progress,
    AiStatus,
    #[default]
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SlotPair {
    pub left: SlotItem,
    pub right: SlotItem,
}

/// The side slots of each state the closed pill can be in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct IslandSlots {
    pub music: SlotPair,
    pub call: SlotPair,
    pub ai: SlotPair,
    pub notification: SlotPair,
    pub system: SlotPair,
}

impl Default for IslandSlots {
    fn default() -> Self {
        Self {
            music: SlotPair { left: SlotItem::Cover, right: SlotItem::Visualizer },
            call: SlotPair { left: SlotItem::AppIcon, right: SlotItem::Remaining },
            ai: SlotPair { left: SlotItem::AiStatus, right: SlotItem::None },
            notification: SlotPair { left: SlotItem::AppIcon, right: SlotItem::None },
            system: SlotPair::default(),
        }
    }
}

/// The pill's shape and material. Whole numbers only: they clamp and compare exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandLook {
    /// Size in percent (replaces small / medium / large).
    pub scale: u16,
    /// Corner radius of the closed pill (px).
    pub radius: u8,
    /// Height of the closed pill (px).
    pub closed_height: u8,
    /// `#rrggbb`. The material from here on applies with the theme "custom".
    pub background: String,
    /// Opacity of the background in percent.
    pub opacity: u8,
    /// How matt the pane is, in percent. A veil, not a blur: Windows can't blur what
    /// lies behind a rounded, transparent window.
    pub frost: u8,
    pub border: IslandBorder,
    /// Shadow strength in percent.
    pub shadow: u8,
    /// `#rrggbb` for the visualizer, progress and NOVA AI's glow; NOVA's accent without one.
    pub accent: Option<String>,
}

pub const SCALE_MIN: u16 = 80;
/// The window is sized for this (island.rs `window_size`).
pub const SCALE_MAX: u16 = 130;
const DEFAULT_BACKGROUND: &str = "#000000";

impl Default for IslandLook {
    fn default() -> Self {
        Self { scale: 100, radius: 22, closed_height: 38, background: DEFAULT_BACKGROUND.into(), opacity: 100, frost: 40, border: IslandBorder::default(), shadow: 60, accent: None }
    }
}

impl IslandLook {
    fn sanitized(mut self) -> Self {
        self.scale = self.scale.clamp(SCALE_MIN, SCALE_MAX);
        self.radius = self.radius.clamp(6, 30);
        self.closed_height = self.closed_height.clamp(30, 46);
        self.background = hex_color(&self.background).unwrap_or_else(|| DEFAULT_BACKGROUND.into());
        self.opacity = self.opacity.clamp(30, 100);
        self.frost = self.frost.min(100);
        self.shadow = self.shadow.min(100);
        self.accent = self.accent.as_deref().and_then(hex_color);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandMotion {
    pub style: MotionStyle,
    /// Tempo in percent: 200 is twice as fast.
    pub speed: u16,
}

impl Default for IslandMotion {
    fn default() -> Self {
        Self { style: MotionStyle::default(), speed: 100 }
    }
}

impl IslandMotion {
    fn sanitized(mut self) -> Self {
        self.speed = self.speed.clamp(50, 200);
        self
    }
}

/// A look the user saved to come back to.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandPreset {
    pub id: String,
    pub name: String,
    pub theme: IslandTheme,
    pub look: IslandLook,
    pub motion: IslandMotion,
    pub slots: IslandSlots,
}

const MOST_PRESETS: usize = 12;
const PRESET_NAME_CHARS: usize = 40;
/// How far the island may be shifted from its anchor (logical px); the screen limits it further.
pub const MOST_OFFSET: i32 = 600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IslandPrefs {
    pub enabled: bool,
    pub theme: IslandTheme,
    pub mode: IslandMode,
    /// "Island only": show the dot inside the island.
    pub dot_in_island: bool,
    pub anchor: IslandAnchor,
    /// Shift along the top edge from the anchor (logical px, right is positive).
    pub offset: i32,
    /// A monitor's name; the primary monitor without one or when it isn't connected.
    pub monitor: Option<String>,
    pub look: IslandLook,
    pub motion: IslandMotion,
    pub slots: IslandSlots,
    /// Who leads when several things happen at once, best first. Always every module once.
    pub order: Vec<ModuleKey>,
    /// A call leads whatever `order` says.
    pub calls_first: bool,
    /// An opened island closes by itself after `minimize_after` seconds without the pointer on it.
    pub auto_minimize: bool,
    pub minimize_after: u8,
    /// How long a phone notification stays (seconds).
    pub notification_seconds: u8,
    pub hide_in_fullscreen: bool,
    pub modules: IslandModules,
    /// Privacy: phone notifications show only the app's name.
    pub hide_previews: bool,
    /// Privacy: calls show the number when the phone sends it.
    pub show_caller_number: bool,
    /// The user's own presets.
    pub presets: Vec<IslandPreset>,
}

impl Default for IslandPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            theme: IslandTheme::default(),
            mode: IslandMode::default(),
            dot_in_island: true,
            anchor: IslandAnchor::default(),
            offset: 0,
            monitor: None,
            look: IslandLook::default(),
            motion: IslandMotion::default(),
            slots: IslandSlots::default(),
            order: ModuleKey::DEFAULT_ORDER.to_vec(),
            calls_first: true,
            auto_minimize: true,
            minimize_after: 6,
            notification_seconds: 8,
            hide_in_fullscreen: true,
            modules: IslandModules::default(),
            hide_previews: false,
            show_caller_number: true,
            presets: Vec::new(),
        }
    }
}

/// `#rrggbb` in lower case, or nothing for anything else (the page puts it into CSS).
fn hex_color(value: &str) -> Option<String> {
    let value = value.trim();
    let digits = value.strip_prefix('#')?;
    (digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit())).then(|| value.to_ascii_lowercase())
}

/// Text for a name or an id: no control characters, at most `most` characters.
fn clean(text: &str, most: usize) -> String {
    text.trim().chars().filter(|c| !c.is_control()).take(most).collect()
}

/// Every module exactly once: what the list names first, then whatever it left out.
fn complete_order(order: &[ModuleKey]) -> Vec<ModuleKey> {
    let mut complete: Vec<ModuleKey> = Vec::with_capacity(ModuleKey::DEFAULT_ORDER.len());
    for key in order.iter().chain(ModuleKey::DEFAULT_ORDER.iter()) {
        if !complete.contains(key) {
            complete.push(*key);
        }
    }
    complete
}

impl IslandPrefs {
    pub fn sanitized(mut self) -> Self {
        self.offset = self.offset.clamp(-MOST_OFFSET, MOST_OFFSET);
        self.minimize_after = self.minimize_after.clamp(3, 30);
        self.notification_seconds = self.notification_seconds.clamp(3, 30);
        self.monitor = self.monitor.map(|m| clean(&m, 120)).filter(|m| !m.is_empty());
        self.look = self.look.sanitized();
        self.motion = self.motion.sanitized();
        self.order = complete_order(&self.order);
        let mut presets: Vec<IslandPreset> = Vec::new();
        for mut preset in std::mem::take(&mut self.presets) {
            preset.id = clean(&preset.id, 40);
            preset.name = clean(&preset.name, PRESET_NAME_CHARS);
            // A preset needs a name to be found by and an id to be told apart by.
            if preset.id.is_empty() || preset.name.is_empty() || presets.iter().any(|p| p.id == preset.id) {
                continue;
            }
            preset.look = preset.look.sanitized();
            preset.motion = preset.motion.sanitized();
            presets.push(preset);
            if presets.len() == MOST_PRESETS {
                break;
            }
        }
        self.presets = presets;
        self
    }

    /// The pill's scale for its size setting.
    pub fn scale(&self) -> f64 {
        f64::from(self.look.scale) / 100.0
    }
}

/// Reads stored preferences of any age, losing as little as possible.
///
/// The first 1.12 builds stored `size` (small / medium / large) and none of the
/// Studio's fields: `size` becomes `look.scale`, the rest take their defaults. A value
/// this version can't read (a key from a newer NOVA, a damaged entry) costs only that
/// one setting, never the whole set.
pub fn parse(raw: &str) -> Option<IslandPrefs> {
    let mut value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object_mut()?;
    if !object.contains_key("look") {
        let scale = match object.get("size").and_then(|size| size.as_str()) {
            Some("small") => Some(88),
            Some("large") => Some(114),
            _ => None,
        };
        if let Some(scale) = scale {
            object.insert("look".into(), serde_json::json!({ "scale": scale }));
        }
    }
    let prefs = match serde_json::from_value::<IslandPrefs>(value.clone()) {
        Ok(prefs) => prefs,
        Err(_) => salvage(value.as_object()?),
    };
    Some(prefs.sanitized())
}

/// Keeps every top-level setting that still reads, on top of the defaults.
fn salvage(stored: &serde_json::Map<String, serde_json::Value>) -> IslandPrefs {
    let mut merged = serde_json::to_value(IslandPrefs::default()).unwrap_or_default();
    for (key, value) in stored {
        let mut candidate = merged.clone();
        candidate[key.as_str()] = value.clone();
        if serde_json::from_value::<IslandPrefs>(candidate.clone()).is_ok() {
            merged = candidate;
        }
    }
    serde_json::from_value(merged).unwrap_or_default()
}

/// The scenes Island Studio can play on the real island for a moment. The page knows
/// what each one shows (src/features/island/scenes.ts); Rust only passes the name on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewScene {
    Idle,
    Music,
    Lyrics,
    Notification,
    Ringing,
    Call,
    AiThinking,
    AiReply,
    System,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_ones_the_page_knows() {
        let page: serde_json::Value = serde_json::from_str(include_str!("../../../src/features/island/default-prefs.json")).unwrap();
        assert_eq!(serde_json::to_value(IslandPrefs::default()).unwrap(), page);
        // And they survive their own limits untouched.
        assert_eq!(IslandPrefs::default().sanitized(), IslandPrefs::default());
    }

    #[test]
    fn the_first_1_12_preferences_move_over_without_loss() {
        let old = r#"{"enabled":false,"theme":"glass","mode":"islandOnly","dotInIsland":false,"anchor":"right","monitor":"\\\\.\\DISPLAY2",
            "size":"large","autoMinimize":false,"minimizeAfter":10,"notificationSeconds":12,"hideInFullscreen":false,
            "modules":{"music":true,"notifications":false,"calls":true,"system":true,"ai":false},"hidePreviews":true,"showCallerNumber":false}"#;
        let prefs = parse(old).unwrap();
        assert_eq!((prefs.enabled, prefs.theme, prefs.mode, prefs.dot_in_island, prefs.anchor), (false, IslandTheme::Glass, IslandMode::IslandOnly, false, IslandAnchor::Right));
        assert_eq!(prefs.monitor.as_deref(), Some(r"\\.\DISPLAY2"));
        assert_eq!((prefs.auto_minimize, prefs.minimize_after, prefs.notification_seconds, prefs.hide_in_fullscreen), (false, 10, 12, false));
        assert_eq!(prefs.modules, IslandModules { music: true, notifications: false, calls: true, system: true, ai: false });
        assert_eq!((prefs.hide_previews, prefs.show_caller_number), (true, false));
        // "large" was 114 %; everything the Studio added starts at its default.
        assert_eq!(prefs.look, IslandLook { scale: 114, ..IslandLook::default() });
        assert_eq!((prefs.offset, prefs.calls_first, prefs.order.as_slice()), (0, true, ModuleKey::DEFAULT_ORDER.as_slice()));
        assert_eq!(prefs.slots, IslandSlots::default());
        assert_eq!(parse(r#"{"size":"small"}"#).unwrap().look.scale, 88);
        assert_eq!(parse(r#"{"size":"medium"}"#).unwrap().look.scale, 100);
        // A size from the old format never overrides a look that is already there.
        assert_eq!(parse(r#"{"size":"small","look":{"scale":120}}"#).unwrap().look.scale, 120);
    }

    #[test]
    fn one_unreadable_setting_costs_only_itself() {
        let prefs = parse(r##"{"enabled":false,"theme":"hologram","anchor":"left","look":{"scale":120,"border":"neon"},"fromTheFuture":{"x":1},"slots":{"music":{"left":"clock"}}}"##).unwrap();
        assert_eq!((prefs.enabled, prefs.anchor), (false, IslandAnchor::Left));
        // An unknown theme and a look with an unknown border fall back; the rest stays.
        assert_eq!((prefs.theme, prefs.look.clone()), (IslandTheme::Black, IslandLook::default()));
        assert_eq!(prefs.slots.music, SlotPair { left: SlotItem::Clock, right: SlotItem::None });
        assert_eq!(prefs.slots.call, IslandSlots::default().call);
        assert!(parse("not json").is_none());
        assert!(parse("[1,2]").is_none());
    }

    #[test]
    fn numbers_and_colors_are_limited() {
        let prefs = IslandPrefs {
            offset: 5000,
            minimize_after: 0,
            notification_seconds: 200,
            monitor: Some("\u{7}".into()),
            look: IslandLook { scale: 400, radius: 0, closed_height: 90, background: "red; } body { display: none".into(), opacity: 3, frost: 250, shadow: 180, accent: Some("#12G".into()), ..IslandLook::default() },
            motion: IslandMotion { style: MotionStyle::Minimal, speed: 9 },
            ..IslandPrefs::default()
        }
        .sanitized();
        assert_eq!((prefs.offset, prefs.minimize_after, prefs.notification_seconds, prefs.monitor.clone()), (MOST_OFFSET, 3, 30, None));
        assert_eq!((prefs.look.scale, prefs.look.radius, prefs.look.closed_height), (SCALE_MAX, 6, 46));
        assert_eq!((prefs.look.background.as_str(), prefs.look.opacity, prefs.look.frost, prefs.look.shadow, prefs.look.accent.clone()), ("#000000", 30, 100, 100, None));
        assert_eq!(prefs.motion, IslandMotion { style: MotionStyle::Minimal, speed: 50 });
        let low = IslandPrefs { offset: -5000, look: IslandLook { scale: 1, background: " #AABBCC ".into(), accent: Some("#22D3EE".into()), ..IslandLook::default() }, motion: IslandMotion { speed: 900, ..IslandMotion::default() }, ..IslandPrefs::default() }.sanitized();
        assert_eq!((low.offset, low.look.scale, low.motion.speed), (-MOST_OFFSET, SCALE_MIN, 200));
        assert_eq!((low.look.background.as_str(), low.look.accent.as_deref()), ("#aabbcc", Some("#22d3ee")));
    }

    #[test]
    fn the_order_always_names_every_module_once() {
        let order = |keys: &[ModuleKey]| IslandPrefs { order: keys.to_vec(), ..IslandPrefs::default() }.sanitized().order;
        assert_eq!(order(&[]), ModuleKey::DEFAULT_ORDER);
        assert_eq!(order(&[ModuleKey::Music, ModuleKey::Music, ModuleKey::Ai]), [ModuleKey::Music, ModuleKey::Ai, ModuleKey::Calls, ModuleKey::Notifications, ModuleKey::System]);
    }

    #[test]
    fn presets_need_a_name_and_stay_few() {
        let preset = |id: &str, name: &str| IslandPreset { id: id.into(), name: name.into(), look: IslandLook { scale: 999, ..IslandLook::default() }, ..IslandPreset::default() };
        let mut presets = vec![preset("a", "  Mein Glas  "), preset("a", "Doppelt"), preset("", "Ohne Kennung"), preset("b", "\u{1}")];
        presets.extend((0..20).map(|i| preset(&format!("p{i}"), &"x".repeat(80))));
        let prefs = IslandPrefs { presets, ..IslandPrefs::default() }.sanitized();
        assert_eq!(prefs.presets.len(), MOST_PRESETS);
        assert_eq!((prefs.presets[0].id.as_str(), prefs.presets[0].name.as_str(), prefs.presets[0].look.scale), ("a", "Mein Glas", SCALE_MAX));
        assert_eq!(prefs.presets[1].id, "p0");
        assert_eq!(prefs.presets[1].name.chars().count(), PRESET_NAME_CHARS);
    }
}
