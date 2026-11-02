//! NOVA AI's typed tool registry. The model can only call these functions;
//! every argument is validated here, file access stays inside the user's
//! folders, and anything that changes something waits for the user's OK.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::provider::ToolSpec;
use crate::capture::Target;
use crate::documents::Format;
use crate::finder::FinderQuery;

/// How much the user has to be involved before a tool runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    /// Runs right away when asked (search, open, show).
    Safe,
    /// Reversible changes and privacy-relevant reads: needs a click on "Allow".
    Confirm,
    /// Hard-to-undo changes: needs explicit confirmation with an explanation.
    High,
}

impl Risk {
    pub fn as_str(self) -> &'static str {
        match self {
            Risk::Safe => "safe",
            Risk::Confirm => "confirm",
            Risk::High => "high",
        }
    }
}

pub fn definitions() -> Vec<ToolSpec> {
    let string = |description: &str| json!({ "type": "string", "description": description });
    let path = string("Full path of a file or folder, exactly as returned by search_files or list_folder.");
    vec![
        ToolSpec {
            name: "search_files",
            description: "Search the user's files and folders by name, folder, type, date and (for text files) content. Use this whenever the user refers to a file you don't have a path for. Returns numbered results with paths.",
            schema: json!({
                "type": "object",
                "properties": {
                    "text": string("Keywords from the name or content, e.g. 'lego berechnung'. Leave out filler words."),
                    "kind": { "type": "string", "enum": crate::finder::KINDS, "description": "Type of item, e.g. pdf, image, presentation, 3d, folder." },
                    "extension": string("File extension without dot, e.g. 'xlsx'."),
                    "modified_within_days": { "type": "integer", "description": "Only items changed in the last N days (e.g. 7 for 'last week')." },
                    "older_than_days": { "type": "integer", "description": "Only items not changed for N days, e.g. to find older versions." },
                    "folder": string("Part of the folder path, e.g. 'Downloads'."),
                },
            }),
        },
        ToolSpec {
            name: "open_file",
            description: "Open a file or folder with its default app (documents, images, PDFs, folders). Programs and scripts can't be opened this way; use open_app for programs.",
            schema: json!({ "type": "object", "properties": { "path": path }, "required": ["path"] }),
        },
        ToolSpec {
            name: "show_in_folder",
            description: "Show a file in File Explorer, selected in its folder.",
            schema: json!({ "type": "object", "properties": { "path": path }, "required": ["path"] }),
        },
        ToolSpec {
            name: "list_folder",
            description: "List the items in one of the user's folders (name, type, size, date).",
            schema: json!({ "type": "object", "properties": { "path": path }, "required": ["path"] }),
        },
        ToolSpec {
            name: "open_app",
            description: "Start an installed application by name (from the Start menu), e.g. 'Spotify' or 'Word'.",
            schema: json!({ "type": "object", "properties": { "name": string("The app's name.") }, "required": ["name"] }),
        },
        ToolSpec {
            name: "open_website",
            description: "Open a web page in the default browser.",
            schema: json!({ "type": "object", "properties": { "url": string("Full http(s) URL.") }, "required": ["url"] }),
        },
        ToolSpec {
            name: "system_info",
            description: "Current CPU, memory, GPU and network load, uptime, and PC details (OS, processor, RAM).",
            schema: json!({ "type": "object", "properties": {} }),
        },
        ToolSpec {
            name: "look_at_screen",
            description: "Take a screenshot so you can see what the user sees. The user is asked for permission first. Use 'window' for the app they were just using, 'screen' for the whole display.",
            schema: json!({ "type": "object", "properties": { "target": { "type": "string", "enum": ["screen", "window"] } }, "required": ["target"] }),
        },
        ToolSpec {
            name: "create_document",
            description: "Create a document from Markdown content and save it (PDF, TXT, Markdown or HTML). Saved in the NOVA workspace (Documents\\NOVA Workspace) unless a folder is given. The user confirms first.",
            schema: json!({
                "type": "object",
                "properties": {
                    "title": string("Document title; also the file name."),
                    "format": { "type": "string", "enum": ["pdf", "txt", "md", "html"] },
                    "content": string("The full document body in Markdown (headings, paragraphs, lists)."),
                    "folder": string("Optional folder to save in (one of the user's folders)."),
                },
                "required": ["title", "format", "content"],
            }),
        },
        ToolSpec {
            name: "create_folder",
            description: "Create a new folder inside one of the user's folders. The user confirms first.",
            schema: json!({ "type": "object", "properties": { "parent": path.clone(), "name": string("Name of the new folder.") }, "required": ["parent", "name"] }),
        },
        ToolSpec {
            name: "move_item",
            description: "Move a file or folder into another folder. The user confirms first.",
            schema: json!({ "type": "object", "properties": { "path": path.clone(), "destination_folder": path.clone() }, "required": ["path", "destination_folder"] }),
        },
        ToolSpec {
            name: "rename_item",
            description: "Rename a file or folder (same folder). The user confirms first.",
            schema: json!({ "type": "object", "properties": { "path": path.clone(), "new_name": string("New name; keeps the file extension if you leave it out.") }, "required": ["path", "new_name"] }),
        },
        ToolSpec {
            name: "delete_item",
            description: "Move a file or folder to the Recycle Bin. High impact: the user must confirm explicitly. Only when the user clearly asked to delete it.",
            schema: json!({ "type": "object", "properties": { "path": path }, "required": ["path"] }),
        },
    ]
}

/// A validated tool call, ready to run.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Search(FinderQuery),
    Open(PathBuf),
    Reveal(PathBuf),
    List(PathBuf),
    OpenApp { id: String, name: String },
    OpenUrl(String),
    SystemInfo,
    LookAtScreen(Target),
    CreateDocument { title: String, format: Format, content: String, folder: Option<PathBuf> },
    CreateFolder(PathBuf),
    Move { from: PathBuf, to: PathBuf },
    Rename { from: PathBuf, to: PathBuf },
    Delete(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Prepared {
    pub action: Action,
    pub risk: Risk,
    /// What will happen, in plain words (shown on cards and in the log).
    pub title: String,
    /// Extra explanation for confirmations.
    pub detail: Option<String>,
}

/// Programs and scripts never open through `open_file`.
const BLOCKED_EXTENSIONS: &[&str] = &["exe", "msi", "bat", "cmd", "com", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr", "pif", "lnk", "url", "reg", "hta", "cpl", "jar", "appref-ms", "msc"];

fn str_arg<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input[key].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| format!("Missing “{key}”"))
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// Resolves a path and checks it lies inside the folders NOVA AI may use.
pub fn allowed_path<R: Runtime>(app: &AppHandle<R>, raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim().trim_matches('"'));
    if !path.is_absolute() {
        return Err("Use the full path from a search result".into());
    }
    let canonical = path.canonicalize().map_err(|_| format!("“{}” doesn't exist", display_name(&path)))?;
    if !allowed_roots_contain(app, &canonical) {
        return Err("NOVA AI only works with your own folders (Documents, Desktop, Downloads, Pictures, Music, Videos, NOVA Finder folders)".into());
    }
    Ok(path)
}

fn allowed_roots_contain<R: Runtime>(app: &AppHandle<R>, canonical: &Path) -> bool {
    crate::finder::allowed_roots(app).iter().any(|root| canonical.starts_with(root))
}

fn safe_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() || name.len() > 200 || name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) || name == "." || name == ".." {
        return Err(format!("“{name}” isn't a valid name"));
    }
    Ok(name.trim_end_matches(['.', ' ']).to_string())
}

/// Checks a tool call's arguments and turns it into an action.
pub fn prepare<R: Runtime>(app: &AppHandle<R>, name: &str, input: &Value) -> Result<Prepared, String> {
    let safe = |action: Action, title: String| Ok(Prepared { action, risk: Risk::Safe, title, detail: None });
    match name {
        "search_files" => {
            let query = FinderQuery {
                text: input["text"].as_str().unwrap_or_default().chars().take(200).collect(),
                kind: input["kind"].as_str().map(str::to_string),
                extension: input["extension"].as_str().map(str::to_string),
                modified_within_days: input["modified_within_days"].as_u64().map(|d| d.min(36500) as u32),
                older_than_days: input["older_than_days"].as_u64().map(|d| d.min(36500) as u32),
                folder: input["folder"].as_str().map(str::to_string),
                limit: Some(12),
            };
            let what = if query.text.trim().is_empty() { query.kind.clone().unwrap_or_else(|| "recent files".into()) } else { format!("“{}”", query.text.trim()) };
            safe(Action::Search(query), format!("Search files for {what}"))
        }
        "open_file" => {
            let path = allowed_path(app, str_arg(input, "path")?)?;
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            if path.is_file() && BLOCKED_EXTENSIONS.contains(&ext.as_str()) {
                return Err("NOVA AI doesn't run programs or scripts from files. Use open_app for installed apps.".into());
            }
            safe(Action::Open(path.clone()), format!("Open {}", display_name(&path)))
        }
        "show_in_folder" => {
            let path = allowed_path(app, str_arg(input, "path")?)?;
            safe(Action::Reveal(path.clone()), format!("Show {} in File Explorer", display_name(&path)))
        }
        "list_folder" => {
            let path = allowed_path(app, str_arg(input, "path")?)?;
            if !path.is_dir() {
                return Err("That's not a folder".into());
            }
            safe(Action::List(path.clone()), format!("Look into {}", display_name(&path)))
        }
        "open_app" => {
            let wanted = str_arg(input, "name")?.to_lowercase();
            let catalog = app.state::<crate::apps::AppCatalog>();
            let (apps, _) = catalog.scanned(false)?;
            let score = |n: &str| {
                let n = n.to_lowercase();
                if n == wanted {
                    0
                } else if n.starts_with(&wanted) {
                    1
                } else if n.split(|c: char| !c.is_alphanumeric()).any(|w| w == wanted) {
                    2
                } else if n.contains(&wanted) {
                    3
                } else {
                    9
                }
            };
            let best = apps.iter().filter(|a| score(&a.name) < 9).min_by_key(|a| (score(&a.name), a.name.len()));
            let app_entry = best.ok_or_else(|| format!("No installed app called “{}” was found in the Start menu", input["name"].as_str().unwrap_or_default()))?;
            safe(Action::OpenApp { id: app_entry.id.clone(), name: app_entry.name.clone() }, format!("Open {}", app_entry.name))
        }
        "open_website" => {
            let url = str_arg(input, "url")?;
            let parsed = url::Url::parse(url).map_err(|_| "That isn't a valid web address".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("Only http(s) web pages can be opened".into());
            }
            safe(Action::OpenUrl(parsed.to_string()), format!("Open {}", parsed.host_str().unwrap_or("the web page")))
        }
        "system_info" => safe(Action::SystemInfo, "Check system status".into()),
        "look_at_screen" => {
            let target = match input["target"].as_str() {
                Some("window") => Target::Window,
                _ => crate::capture::current_target(app),
            };
            let title = if target == Target::Window { "Look at the window you're using" } else { "Look at your screen" };
            Ok(Prepared {
                action: Action::LookAtScreen(target),
                risk: Risk::Confirm,
                title: title.into(),
                detail: Some("NOVA takes one screenshot (without its own windows) and sends it to your AI provider with this conversation.".into()),
            })
        }
        "create_document" => {
            let title = str_arg(input, "title")?.chars().take(120).collect::<String>();
            let format: Format = serde_json::from_value(input["format"].clone()).map_err(|_| "Choose pdf, txt, md or html".to_string())?;
            let content = input["content"].as_str().unwrap_or_default().to_string();
            if content.trim().is_empty() {
                return Err("The document has no content".into());
            }
            let folder = match input["folder"].as_str().filter(|f| !f.trim().is_empty()) {
                Some(f) => {
                    let folder = allowed_path(app, f)?;
                    if !folder.is_dir() {
                        return Err("That folder doesn't exist".into());
                    }
                    Some(folder)
                }
                None => None,
            };
            let place = folder.as_ref().map_or_else(|| "your NOVA workspace (Documents\\NOVA Workspace)".to_string(), |f| display_name(f));
            let words = content.split_whitespace().count();
            Ok(Prepared {
                title: format!("Create “{title}” as {} in {place}", format!("{format:?}").to_uppercase()),
                detail: Some(format!("About {words} words. Existing files are never overwritten.")),
                action: Action::CreateDocument { title, format, content, folder },
                risk: Risk::Confirm,
            })
        }
        "create_folder" => {
            let parent = allowed_path(app, str_arg(input, "parent")?)?;
            let name = safe_name(str_arg(input, "name")?)?;
            let target = parent.join(&name);
            if target.exists() {
                return Err(format!("“{name}” already exists there"));
            }
            Ok(Prepared {
                title: format!("Create the folder “{name}” in {}", display_name(&parent)),
                detail: None,
                action: Action::CreateFolder(target),
                risk: Risk::Confirm,
            })
        }
        "move_item" => {
            let from = allowed_path(app, str_arg(input, "path")?)?;
            let folder = allowed_path(app, str_arg(input, "destination_folder")?)?;
            if !folder.is_dir() {
                return Err("The destination isn't a folder".into());
            }
            let to = folder.join(from.file_name().ok_or("That item has no name")?);
            if to.exists() {
                return Err(format!("{} already contains “{}”", display_name(&folder), display_name(&from)));
            }
            if from.is_dir() && folder.canonicalize().ok().zip(from.canonicalize().ok()).is_some_and(|(f, s)| f.starts_with(&s)) {
                return Err("A folder can't be moved into itself".into());
            }
            Ok(Prepared {
                title: format!("Move {} to {}", display_name(&from), display_name(&folder)),
                detail: Some(format!("From {}", from.parent().map(|p| p.display().to_string()).unwrap_or_default())),
                action: Action::Move { from, to },
                risk: Risk::Confirm,
            })
        }
        "rename_item" => {
            let from = allowed_path(app, str_arg(input, "path")?)?;
            let mut new_name = safe_name(str_arg(input, "new_name")?)?;
            if from.is_file() && Path::new(&new_name).extension().is_none() {
                if let Some(ext) = from.extension() {
                    new_name = format!("{new_name}.{}", ext.to_string_lossy());
                }
            }
            let to = from.with_file_name(&new_name);
            if to.exists() {
                return Err(format!("“{new_name}” already exists there"));
            }
            Ok(Prepared {
                title: format!("Rename {} to {new_name}", display_name(&from)),
                detail: None,
                action: Action::Rename { from, to },
                risk: Risk::Confirm,
            })
        }
        "delete_item" => {
            let path = allowed_path(app, str_arg(input, "path")?)?;
            let what = if path.is_dir() { "folder and everything in it" } else { "file" };
            Ok(Prepared {
                title: format!("Delete {}", display_name(&path)),
                detail: Some(format!("Moves this {what} to the Recycle Bin: {}. You can restore it from there.", path.display())),
                action: Action::Delete(path),
                risk: Risk::High,
            })
        }
        other => Err(format!("Unknown tool “{other}”")),
    }
}

/// The result of running a tool.
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    /// What the model reads.
    pub for_model: String,
    /// One line for the action log and the tool card.
    pub summary: String,
    /// Structured data the panel renders (file results, documents, screenshots).
    pub card: Option<Value>,
    /// An image for the model (screenshots).
    pub image: Option<(String, String)>,
}

fn file_lines(hits: &[crate::storage::file_index::FileHit]) -> String {
    hits.iter()
        .enumerate()
        .map(|(i, h)| {
            let date = chrono_like(h.modified);
            let snippet = h.snippet.as_deref().map(|s| format!(" — “{}”", s.replace('\n', " "))).unwrap_or_default();
            format!("{}. {} [{}] {} · {} · {}{}", i + 1, h.name, h.kind, h.path, human_size(h.size), date, snippet)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn human_size(bytes: i64) -> String {
    match bytes {
        b if b < 0 => "—".into(),
        b if b < 1024 => format!("{b} B"),
        b if b < 1024 * 1024 => format!("{:.0} KB", b as f64 / 1024.0),
        b if b < 1024 * 1024 * 1024 => format!("{:.1} MB", b as f64 / 1048576.0),
        b => format!("{:.1} GB", b as f64 / 1073741824.0),
    }
}

/// "2026-11-02" from epoch milliseconds (UTC date; good enough for the model).
fn chrono_like(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Runs a prepared action. Blocking; call off the async runtime.
pub fn execute<R: Runtime>(app: &AppHandle<R>, action: &Action) -> Result<Outcome, String> {
    match action {
        Action::Search(query) => {
            let result = crate::finder::search(app, query)?;
            let count = result.hits.len();
            let note = if result.source == "live" {
                "\n(NOVA Finder has no indexed folders yet, so only file names in the standard folders were scanned. The user can add folders in Settings → NOVA AI assistant.)"
            } else {
                ""
            };
            Ok(Outcome {
                for_model: if count == 0 { format!("No matches.{note}") } else { format!("{count} result(s):\n{}{note}", file_lines(&result.hits)) },
                summary: match count {
                    0 => "No matches".into(),
                    1 => "1 match".into(),
                    n => format!("{n} matches"),
                },
                card: Some(json!({ "kind": "files", "hits": result.hits, "source": result.source })),
                image: None,
            })
        }
        Action::Open(path) => {
            crate::shell::open_path(path)?;
            Ok(Outcome { for_model: format!("Opened {}", path.display()), summary: format!("Opened {}", display_name(path)), ..Outcome::default() })
        }
        Action::Reveal(path) => {
            crate::shell::reveal_path(path)?;
            Ok(Outcome { for_model: "Shown in File Explorer".into(), summary: format!("Showed {} in File Explorer", display_name(path)), ..Outcome::default() })
        }
        Action::List(path) => {
            let entries = crate::files::list_dir(path)?;
            let lines: Vec<String> = entries
                .iter()
                .take(150)
                .map(|e| if e.is_dir { format!("[folder] {}", e.path) } else { format!("{} · {} · {}", e.path, human_size(e.size as i64), chrono_like(e.modified_ms as i64)) })
                .collect();
            Ok(Outcome {
                for_model: if lines.is_empty() { "The folder is empty.".into() } else { format!("{} item(s):\n{}", entries.len(), lines.join("\n")) },
                summary: format!("{} items in {}", entries.len(), display_name(path)),
                ..Outcome::default()
            })
        }
        Action::OpenApp { id, name } => {
            let db = app.state::<crate::storage::Database>();
            let path = app.state::<crate::apps::AppCatalog>().resolve(&db, id)?;
            crate::shell::open_path(&path)?;
            Ok(Outcome { for_model: format!("Started {name}"), summary: format!("Opened {name}"), card: Some(json!({ "kind": "app", "name": name })), image: None })
        }
        Action::OpenUrl(url) => {
            crate::shell::open_url(url)?;
            Ok(Outcome { for_model: format!("Opened {url}"), summary: format!("Opened {url}"), ..Outcome::default() })
        }
        Action::SystemInfo => {
            let overview = crate::system::overview(&app.state::<crate::system::SystemMonitor>())?;
            Ok(Outcome { for_model: overview.to_string(), summary: "Checked system status".into(), ..Outcome::default() })
        }
        Action::LookAtScreen(target) => {
            let shot = crate::capture::capture(app, target)?;
            Ok(Outcome {
                for_model: format!("Screenshot of {} ({}×{} px) attached.", shot.label, shot.width, shot.height),
                summary: format!("Looked at {}", shot.label.to_lowercase()),
                card: Some(json!({ "kind": "screenshot", "label": shot.label, "dataUrl": format!("data:image/png;base64,{}", shot.png_base64) })),
                image: Some(("image/png".into(), shot.png_base64)),
            })
        }
        Action::CreateDocument { title, format, content, folder } => {
            let saved = crate::documents::create(title, *format, content, folder.as_deref())?;
            Ok(Outcome {
                for_model: format!("Saved {} ({}) at {}", saved.name, human_size(saved.size as i64), saved.path),
                summary: format!("Created {}", saved.name),
                card: Some(json!({ "kind": "document", "document": saved })),
                image: None,
            })
        }
        Action::CreateFolder(path) => {
            std::fs::create_dir(path).map_err(|e| format!("Couldn't create the folder: {e}"))?;
            Ok(Outcome { for_model: format!("Created {}", path.display()), summary: format!("Created folder {}", display_name(path)), ..Outcome::default() })
        }
        Action::Move { from, to } => {
            move_path(from, to)?;
            Ok(Outcome {
                for_model: format!("Moved to {}", to.display()),
                summary: format!("Moved {} to {}", display_name(from), to.parent().map(display_name).unwrap_or_default()),
                card: Some(json!({ "kind": "path", "path": to.to_string_lossy() })),
                image: None,
            })
        }
        Action::Rename { from, to } => {
            std::fs::rename(from, to).map_err(|e| format!("Couldn't rename: {e}"))?;
            Ok(Outcome {
                for_model: format!("Renamed to {}", to.display()),
                summary: format!("Renamed {} to {}", display_name(from), display_name(to)),
                card: Some(json!({ "kind": "path", "path": to.to_string_lossy() })),
                image: None,
            })
        }
        Action::Delete(path) => {
            recycle(path)?;
            Ok(Outcome { for_model: format!("Moved {} to the Recycle Bin", path.display()), summary: format!("Moved {} to the Recycle Bin", display_name(path)), ..Outcome::default() })
        }
    }
}

fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        // Different drive: copy files, then remove the original. Folders must stay on one drive.
        Err(_) if from.is_file() => {
            std::fs::copy(from, to).map_err(|e| format!("Couldn't copy: {e}"))?;
            if std::fs::metadata(to).map(|m| m.len()).ok() != std::fs::metadata(from).map(|m| m.len()).ok() {
                let _ = std::fs::remove_file(to);
                return Err("The copy didn't complete; nothing was moved".into());
            }
            std::fs::remove_file(from).map_err(|e| format!("Copied, but couldn't remove the original: {e}"))
        }
        Err(e) => Err(format!("Couldn't move: {e}")),
    }
}

#[cfg(windows)]
fn recycle(path: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    // Double-NUL-terminated list with one path.
    let mut from: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().collect();
    from.extend([0, 0]);
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
        ..Default::default()
    };
    // SAFETY: `from` outlives the call and is double-NUL-terminated as required.
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result == 0 && !operation.fAnyOperationsAborted.as_bool() && !path.exists() {
        Ok(())
    } else {
        Err(format!("Windows couldn't move it to the Recycle Bin (error {result})"))
    }
}

#[cfg(not(windows))]
fn recycle(_: &Path) -> Result<(), String> {
    Err("The Recycle Bin requires Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_has_an_object_schema_and_unique_name() {
        let tools = definitions();
        let mut names: Vec<&str> = tools.iter().map(|t| t.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), tools.len());
        for tool in &tools {
            assert_eq!(tool.schema["type"], "object", "{}", tool.name);
            // Gemini rejects schemas with additionalProperties.
            assert!(!tool.schema.to_string().contains("additionalProperties"));
            assert!(tool.description.len() > 20);
        }
    }

    #[test]
    fn validates_names() {
        assert_eq!(safe_name("Fotos 2026").unwrap(), "Fotos 2026");
        assert_eq!(safe_name("Bericht. ").unwrap(), "Bericht");
        assert!(safe_name("a/b").is_err());
        assert!(safe_name("..").is_err());
        assert!(safe_name("  ").is_err());
    }

    #[test]
    fn formats_sizes_and_dates() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2 KB");
        assert_eq!(human_size(5 * 1048576), "5.0 MB");
        assert_eq!(chrono_like(0), "1970-01-01");
        assert_eq!(chrono_like(1_793_577_600_000), "2026-11-02");
    }
}
