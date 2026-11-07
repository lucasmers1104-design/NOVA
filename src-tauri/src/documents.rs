//! Documents NOVA AI writes: Markdown, plain text, HTML or PDF, saved in the
//! NOVA workspace (Documents\NOVA Workspace). A file is reported as saved only after it
//! was written and read back from disk.
//!
//! The PDF writer is self-contained: A4 pages, the standard Helvetica fonts
//! and Windows-1252 text (all Western European characters, € and typographic
//! quotes). Characters outside it are written as "?".

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

type CommandResult<T> = Result<T, String>;

const MAX_CONTENT_CHARS: usize = 400_000;
/// Inside Documents; deliberately not plain "NOVA", which people use for other things.
pub const WORKSPACE_NAME: &str = "NOVA Workspace";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Pdf,
    Md,
    Txt,
    Html,
}

impl Format {
    fn extension(self) -> &'static str {
        match self {
            Format::Pdf => "pdf",
            Format::Md => "md",
            Format::Txt => "txt",
            Format::Html => "html",
        }
    }
}

/// One page of a PDF as a picture, and how many pages it has: Windows' own PDF
/// reader draws it, also pages that are only scans.
#[cfg(windows)]
pub fn pdf_page_png(path: &Path, page: u32) -> CommandResult<(Vec<u8>, u32)> {
    use windows::core::HSTRING;
    use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};
    let fail = |e: windows::core::Error| format!("Windows couldn't read this PDF: {}", e.message());
    crate::shell::with_com(false, || {
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        let plain = canonical.to_string_lossy();
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(plain.strip_prefix(r"\\?\").unwrap_or(&plain))).map_err(fail)?.join().map_err(fail)?;
        let document = PdfDocument::LoadFromFileAsync(&file).map_err(fail)?.join().map_err(fail)?;
        let pages = document.PageCount().map_err(fail)?;
        if page == 0 || page > pages {
            return Err(format!("This PDF has {pages} pages."));
        }
        let drawn = document.GetPage(page - 1).map_err(fail)?;
        let stream = InMemoryRandomAccessStream::new().map_err(fail)?;
        let options = PdfPageRenderOptions::new().map_err(fail)?;
        // Sharp enough to read small print, small enough to send.
        options.SetDestinationWidth(1400).map_err(fail)?;
        drawn.RenderWithOptionsToStreamAsync(&stream, &options).map_err(fail)?.join().map_err(fail)?;
        stream.Seek(0).map_err(fail)?;
        let size = stream.Size().map_err(fail)? as u32;
        let reader = DataReader::CreateDataReader(&stream).map_err(fail)?;
        reader.LoadAsync(size).map_err(fail)?.join().map_err(fail)?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes).map_err(fail)?;
        Ok((bytes, pages))
    })
}

#[cfg(not(windows))]
pub fn pdf_page_png(_: &Path, _: u32) -> CommandResult<(Vec<u8>, u32)> {
    Err("This requires Windows".into())
}

/// The text of a Word document: a zip file with its text in one XML file.
pub fn docx_text(bytes: &[u8]) -> CommandResult<String> {
    use std::io::Read;
    const NOT_WORD: &str = "This doesn't look like a Word document";
    let u16_at = |at: usize| -> Option<usize> { Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as usize) };
    let u32_at = |at: usize| -> Option<usize> { Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?) as usize) };
    let end = bytes.windows(4).rposition(|four| four == b"PK\x05\x06").ok_or(NOT_WORD)?;
    let mut entry = u32_at(end + 16).ok_or(NOT_WORD)?;
    for _ in 0..u16_at(end + 10).ok_or(NOT_WORD)? {
        if bytes.get(entry..entry + 4) != Some(b"PK\x01\x02") {
            break;
        }
        let (method, packed, name_len) = (u16_at(entry + 10).ok_or(NOT_WORD)?, u32_at(entry + 20).ok_or(NOT_WORD)?, u16_at(entry + 28).ok_or(NOT_WORD)?);
        let (extra_len, note_len, local) = (u16_at(entry + 30).ok_or(NOT_WORD)?, u16_at(entry + 32).ok_or(NOT_WORD)?, u32_at(entry + 42).ok_or(NOT_WORD)?);
        if bytes.get(entry + 46..entry + 46 + name_len) == Some(b"word/document.xml") {
            let start = local + 30 + u16_at(local + 26).ok_or(NOT_WORD)? + u16_at(local + 28).ok_or(NOT_WORD)?;
            let data = bytes.get(start..start + packed).ok_or(NOT_WORD)?;
            let mut xml = Vec::new();
            let read = match method {
                0 => data.take(MAX_CONTENT_CHARS as u64 * 8).read_to_end(&mut xml),
                _ => flate2::read::DeflateDecoder::new(data).take(MAX_CONTENT_CHARS as u64 * 8).read_to_end(&mut xml),
            };
            read.map_err(|_| NOT_WORD.to_string())?;
            return Ok(crate::agent::web::html_to_text(&String::from_utf8_lossy(&xml).replace("</w:p>", "<br>")).1);
        }
        entry += 46 + name_len + extra_len + note_len;
    }
    Err(NOT_WORD.into())
}

/// `Documents\NOVA Workspace`, created on first use.
pub fn workspace() -> CommandResult<PathBuf> {
    let documents = crate::files::known_folders()
        .into_iter()
        .find(|f| f.id == "documents")
        .map(|f| PathBuf::from(f.path))
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Documents")))
        .ok_or("Couldn't find your Documents folder")?;
    let workspace = documents.join(WORKSPACE_NAME);
    std::fs::create_dir_all(&workspace).map_err(|e| format!("Couldn't create {}: {e}", workspace.display()))?;
    Ok(workspace)
}

/// A file name Windows accepts, without the extension.
pub fn safe_file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut stem: String = cleaned.trim_matches(|c: char| c == '.' || c == ' ').chars().take(80).collect();
    const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"];
    if stem.is_empty() || RESERVED.contains(&stem.to_lowercase().as_str()) {
        stem = "NOVA document".into();
    }
    stem
}

/// `folder\stem.ext`, or `stem (2).ext` and so on if that exists.
fn free_path(folder: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = folder.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..1000).map(|n| folder.join(format!("{stem} ({n}).{ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocument {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub size: u64,
    pub format: Format,
}

/// Writes `markdown` as a document of `format` into `folder` (the workspace by default).
pub fn create(title: &str, format: Format, markdown: &str, folder: Option<&Path>) -> CommandResult<SavedDocument> {
    let title = title.trim();
    if title.is_empty() {
        return Err("The document needs a title".into());
    }
    if markdown.chars().count() > MAX_CONTENT_CHARS {
        return Err("The document is too long".into());
    }
    let folder = match folder {
        Some(f) => f.to_path_buf(),
        None => workspace()?,
    };
    let path = free_path(&folder, &safe_file_stem(title), format.extension());
    let bytes = match format {
        Format::Md => with_title_heading(title, markdown).into_bytes(),
        Format::Txt => to_plain_text(&with_title_heading(title, markdown)).replace('\n', "\r\n").into_bytes(),
        Format::Html => to_html(title, markdown).into_bytes(),
        Format::Pdf => to_pdf(title, markdown),
    };
    std::fs::write(&path, &bytes).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    // Only a file that is really there counts as saved.
    let size = std::fs::metadata(&path).map_err(|e| format!("The file wasn't saved: {e}"))?.len();
    if size != bytes.len() as u64 {
        return Err("The file on disk doesn't match what was written".into());
    }
    Ok(SavedDocument {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        folder: folder.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        size,
        format,
    })
}

fn with_title_heading(title: &str, markdown: &str) -> String {
    let body = markdown.trim();
    if body.lines().next().is_some_and(|l| l.trim_start_matches('#').trim().eq_ignore_ascii_case(title)) {
        format!("{body}\n")
    } else {
        format!("# {title}\n\n{body}\n")
    }
}

// ---------------------------------------------------------------------------
// Markdown subset: headings, paragraphs, bullet and numbered lists, code
// blocks, quotes, **bold**, *italic* and `code` inline.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Block {
    Heading(u8, String),
    Paragraph(String),
    Bullet(String),
    Numbered(String, String),
    Code(String),
    Quote(String),
    Rule,
}

fn parse_blocks(markdown: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut code: Option<Vec<String>> = None;
    let flush = |paragraph: &mut Vec<String>, blocks: &mut Vec<Block>| {
        if !paragraph.is_empty() {
            blocks.push(Block::Paragraph(paragraph.join(" ")));
            paragraph.clear();
        }
    };
    for raw in markdown.lines() {
        let line = raw.trim_end();
        if let Some(lines) = code.as_mut() {
            if line.trim_start().starts_with("```") {
                blocks.push(Block::Code(lines.join("\n")));
                code = None;
            } else {
                lines.push(line.to_string());
            }
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            flush(&mut paragraph, &mut blocks);
            code = Some(Vec::new());
        } else if trimmed.is_empty() {
            flush(&mut paragraph, &mut blocks);
        } else if let Some(level) = (1..=6).rev().find(|n| trimmed.starts_with(&format!("{} ", "#".repeat(*n)))) {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Heading(level as u8, trimmed[level + 1..].trim().to_string()));
        } else if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Rule);
        } else if let Some(item) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")).or_else(|| trimmed.strip_prefix("• ")) {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Bullet(item.trim().to_string()));
        } else if let Some((number, item)) = numbered(trimmed) {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Numbered(number, item));
        } else if let Some(quote) = trimmed.strip_prefix("> ").or_else(|| trimmed.strip_prefix('>')) {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Quote(quote.trim().to_string()));
        } else {
            paragraph.push(trimmed.to_string());
        }
    }
    if let Some(lines) = code {
        blocks.push(Block::Code(lines.join("\n")));
    }
    flush(&mut paragraph, &mut blocks);
    blocks
}

fn numbered(line: &str) -> Option<(String, String)> {
    let digits: String = line.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 3 {
        return None;
    }
    let rest = line[digits.len()..].strip_prefix(". ").or_else(|| line[digits.len()..].strip_prefix(") "))?;
    Some((digits, rest.trim().to_string()))
}

/// Inline markers removed: **bold**, *italic*, `code`, [text](url) → text (url).
fn strip_inline(text: &str) -> String {
    let mut out = strip_pairs(&strip_pairs(text, "**"), "__").replace('`', "");
    // Links: [label](url) → label (url)
    while let (Some(open), Some(mid)) = (out.find('['), out.find("](")) {
        let Some(close) = out[mid..].find(')').map(|i| mid + i) else { break };
        if !(open < mid && mid < close) {
            break;
        }
        let label = out[open + 1..mid].to_string();
        let url = out[mid + 2..close].to_string();
        out.replace_range(open..=close, &format!("{label} ({url})"));
    }
    strip_pairs(&out, "*")
}

/// Removes `marker` where it emphasizes something: "**a b**" → "a b", but "3 * 4 * 5" and a lone "*" stay.
fn strip_pairs(text: &str, marker: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find(marker) {
        let after = &rest[open + marker.len()..];
        let closing = after.char_indices().find(|(i, c)| *c != ' ' && after[*i + c.len_utf8()..].starts_with(marker)).map(|(i, c)| i + c.len_utf8());
        match closing.filter(|_| !after.starts_with([' ', '\t'])) {
            Some(close) => {
                out.push_str(&rest[..open]);
                out.push_str(&after[..close]);
                rest = &after[close + marker.len()..];
            }
            None => {
                out.push_str(&rest[..open + marker.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn to_plain_text(markdown: &str) -> String {
    let mut out = String::new();
    for block in parse_blocks(markdown) {
        match block {
            Block::Heading(level, text) => {
                let text = strip_inline(&text);
                let underline = if level == 1 { '=' } else { '-' };
                let _ = writeln!(out, "{text}\n{}\n", underline.to_string().repeat(text.chars().count().max(3)));
            }
            Block::Paragraph(text) => {
                let _ = writeln!(out, "{}\n", strip_inline(&text));
            }
            Block::Bullet(text) => {
                let _ = writeln!(out, "• {}", strip_inline(&text));
            }
            Block::Numbered(n, text) => {
                let _ = writeln!(out, "{n}. {}", strip_inline(&text));
            }
            Block::Code(code) => {
                let _ = writeln!(out, "{}\n", code.lines().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n"));
            }
            Block::Quote(text) => {
                let _ = writeln!(out, "  „{}“\n", strip_inline(&text));
            }
            Block::Rule => out.push_str("----------------------------------------\n\n"),
        }
    }
    out.trim_end().to_string() + "\n"
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Escaped text with **bold**, *italic*, `code` and http(s) links.
fn inline_html(text: &str) -> String {
    let mut html = escape_html(text);
    let mut toggle = |marker: &str, open: &str, close: &str| {
        let mut out = String::new();
        let mut parts = html.split(marker).peekable();
        let mut inside = false;
        while let Some(part) = parts.next() {
            out.push_str(part);
            if parts.peek().is_some() {
                out.push_str(if inside { close } else { open });
                inside = !inside;
            }
        }
        if inside {
            out.push_str(close);
        }
        html = out;
    };
    toggle("**", "<strong>", "</strong>");
    toggle("`", "<code>", "</code>");
    toggle("*", "<em>", "</em>");
    // [label](https://…) links; other schemes stay plain text.
    let mut out = String::new();
    let mut rest = html.as_str();
    while let Some(open) = rest.find('[') {
        let Some(mid) = rest[open..].find("](").map(|i| open + i) else { break };
        let Some(close) = rest[mid..].find(')').map(|i| mid + i) else { break };
        let url = &rest[mid + 2..close];
        out.push_str(&rest[..open]);
        if url.starts_with("https://") || url.starts_with("http://") {
            let _ = write!(out, r#"<a href="{url}">{}</a>"#, &rest[open + 1..mid]);
        } else {
            out.push_str(&rest[open..=close]);
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out
}

fn to_html(title: &str, markdown: &str) -> String {
    let mut body = String::new();
    let mut list: Option<&str> = None;
    let blocks = parse_blocks(&with_title_heading(title, markdown));
    for block in blocks {
        let wanted = match &block {
            Block::Bullet(_) => Some("ul"),
            Block::Numbered(..) => Some("ol"),
            _ => None,
        };
        if list != wanted {
            if let Some(tag) = list {
                let _ = writeln!(body, "</{tag}>");
            }
            if let Some(tag) = wanted {
                let _ = writeln!(body, "<{tag}>");
            }
            list = wanted;
        }
        match block {
            Block::Heading(level, text) => {
                let _ = writeln!(body, "<h{level}>{}</h{level}>", inline_html(&text));
            }
            Block::Paragraph(text) => {
                let _ = writeln!(body, "<p>{}</p>", inline_html(&text));
            }
            Block::Bullet(text) | Block::Numbered(_, text) => {
                let _ = writeln!(body, "<li>{}</li>", inline_html(&text));
            }
            Block::Code(code) => {
                let _ = writeln!(body, "<pre><code>{}</code></pre>", escape_html(&code));
            }
            Block::Quote(text) => {
                let _ = writeln!(body, "<blockquote>{}</blockquote>", inline_html(&text));
            }
            Block::Rule => body.push_str("<hr>\n"),
        }
    }
    if let Some(tag) = list {
        let _ = writeln!(body, "</{tag}>");
    }
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="NOVA AI">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ max-width: 46rem; margin: 3rem auto; padding: 0 1.5rem; font: 16px/1.65 "Segoe UI", system-ui, sans-serif; color: #1d2130; background: #fbfbfd; }}
  h1, h2, h3 {{ line-height: 1.25; margin: 1.8em 0 0.6em; }}
  h1 {{ font-size: 2rem; margin-top: 0; }}
  code {{ font-family: Consolas, monospace; background: #eef0f5; padding: 0.1em 0.35em; border-radius: 4px; }}
  pre {{ background: #eef0f5; padding: 1rem; border-radius: 10px; overflow-x: auto; }}
  pre code {{ background: none; padding: 0; }}
  blockquote {{ margin: 1em 0; padding-left: 1em; border-left: 3px solid #8b5cf6; color: #4a5068; }}
  a {{ color: #6d3fe0; }}
  hr {{ border: 0; border-top: 1px solid #d9dce6; margin: 2rem 0; }}
  @media (prefers-color-scheme: dark) {{
    body {{ color: #e8eaf2; background: #10131c; }}
    code, pre {{ background: #1c2130; }}
    blockquote {{ color: #a9afc3; }}
    a {{ color: #a78bfa; }}
    hr {{ border-top-color: #2a3042; }}
  }}
</style>
</head>
<body>
{body}</body>
</html>
"#,
        title = escape_html(title)
    )
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/// Helvetica glyph widths (1/1000 em) for ASCII 32–126.
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278,
    278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
    667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
    556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// Helvetica-Bold glyph widths (1/1000 em) for ASCII 32–126.
const HELVETICA_BOLD: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333,
    333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
    667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611,
    611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/// Windows-1252 byte for a character; `?` when it has none.
fn cp1252(c: char) -> u8 {
    const HIGH: [(char, u8); 27] = [
        ('€', 0x80), ('‚', 0x82), ('ƒ', 0x83), ('„', 0x84), ('…', 0x85), ('†', 0x86), ('‡', 0x87), ('ˆ', 0x88), ('‰', 0x89), ('Š', 0x8A),
        ('‹', 0x8B), ('Œ', 0x8C), ('Ž', 0x8E), ('‘', 0x91), ('’', 0x92), ('“', 0x93), ('”', 0x94), ('•', 0x95), ('–', 0x96), ('—', 0x97),
        ('˜', 0x98), ('™', 0x99), ('š', 0x9A), ('›', 0x9B), ('œ', 0x9C), ('ž', 0x9E), ('Ÿ', 0x9F),
    ];
    match c as u32 {
        0x20..=0x7E | 0xA0..=0xFF => c as u8,
        _ => HIGH.iter().find(|(ch, _)| *ch == c).map_or(b'?', |(_, b)| *b),
    }
}

/// Width of a Windows-1252 byte in 1/1000 em. Accented letters use their base letter.
fn glyph_width(byte: u8, bold: bool) -> u16 {
    let table = if bold { &HELVETICA_BOLD } else { &HELVETICA };
    let base = match byte {
        0x20..=0x7E => byte,
        0xC0..=0xC5 => b'A',
        0xC7 => b'C',
        0xC8..=0xCB => b'E',
        0xCC..=0xCF => b'I',
        0xD1 => b'N',
        0xD2..=0xD6 | 0xD8 => b'O',
        0xD9..=0xDC => b'U',
        0xDD => b'Y',
        0xE0..=0xE5 => b'a',
        0xE7 => b'c',
        0xE8..=0xEB => b'e',
        0xEC..=0xEF => b'i',
        0xF1 => b'n',
        0xF2..=0xF6 | 0xF8 => b'o',
        0xF9..=0xFC => b'u',
        0xFD | 0xFF => b'y',
        0xDF => return 611,
        0x95 => return 350,
        0x96 => return 556,
        0x97 => return 1000,
        0x85 => return 1000,
        _ => return 556,
    };
    table[(base - 0x20) as usize]
}

struct Line {
    text: Vec<u8>,
    size: f32,
    bold: bool,
    indent: f32,
    /// Extra space before this line (points).
    gap: f32,
}

const PAGE_W: f32 = 595.0;
const PAGE_H: f32 = 842.0;
const MARGIN: f32 = 64.0;

/// Splits text into lines that fit `width` points.
fn wrap(text: &str, size: f32, bold: bool, width: f32) -> Vec<Vec<u8>> {
    let bytes: Vec<u8> = text.chars().map(cp1252).collect();
    let measure = |word: &[u8]| word.iter().map(|b| glyph_width(*b, bold) as f32).sum::<f32>() * size / 1000.0;
    let space = glyph_width(b' ', bold) as f32 * size / 1000.0;
    let mut lines = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut line_width = 0.0;
    for word in bytes.split(|b| *b == b' ').filter(|w| !w.is_empty()) {
        let w = measure(word);
        if !line.is_empty() && line_width + space + w > width {
            lines.push(std::mem::take(&mut line));
            line_width = 0.0;
        }
        if !line.is_empty() {
            line.push(b' ');
            line_width += space;
        }
        // A single word longer than the line is broken by characters.
        if w > width {
            for &b in word {
                let bw = glyph_width(b, bold) as f32 * size / 1000.0;
                if line_width + bw > width && !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                    line_width = 0.0;
                }
                line.push(b);
                line_width += bw;
            }
        } else {
            line.extend_from_slice(word);
            line_width += w;
        }
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}

/// A code line: keeps its spaces (tabs become four) and breaks by characters.
fn wrap_code(text: &str, size: f32, width: f32) -> Vec<Vec<u8>> {
    let mut lines = vec![Vec::new()];
    let mut line_width = 0.0;
    for byte in text.replace('\t', "    ").chars().map(cp1252) {
        let w = glyph_width(byte, false) as f32 * size / 1000.0;
        if line_width + w > width {
            lines.push(Vec::new());
            line_width = 0.0;
        }
        lines.last_mut().expect("starts with one line").push(byte);
        line_width += w;
    }
    lines
}

fn layout(title: &str, markdown: &str) -> Vec<Line> {
    let width = PAGE_W - 2.0 * MARGIN;
    let mut lines = Vec::new();
    let mut push_wrapped = |wrapped: Vec<Vec<u8>>, size: f32, bold: bool, indent: f32, gap: f32, prefix: Option<&str>| {
        for (i, wrapped) in wrapped.into_iter().enumerate() {
            let mut bytes = Vec::new();
            if i == 0 {
                if let Some(p) = prefix {
                    bytes.extend(p.chars().map(cp1252));
                }
            }
            bytes.extend(wrapped);
            lines.push(Line { text: bytes, size, bold, indent: if i == 0 && prefix.is_some() { indent - 12.0 } else { indent }, gap: if i == 0 { gap } else { 0.0 } });
        }
    };
    for block in parse_blocks(&with_title_heading(title, markdown)) {
        let mut push = |text: &str, size: f32, bold: bool, indent: f32, gap: f32, prefix: Option<&str>| push_wrapped(wrap(text, size, bold, width - indent), size, bold, indent, gap, prefix);
        match block {
            Block::Heading(level, text) => {
                let size = match level {
                    1 => 22.0,
                    2 => 16.0,
                    3 => 13.5,
                    _ => 12.0,
                };
                push(&strip_inline(&text), size, true, 0.0, size * 0.9, None);
            }
            Block::Paragraph(text) => push(&strip_inline(&text), 11.0, false, 0.0, 8.0, None),
            Block::Bullet(text) => push(&strip_inline(&text), 11.0, false, 16.0, 3.0, Some("• ")),
            Block::Numbered(n, text) => push(&strip_inline(&text), 11.0, false, 16.0, 3.0, Some(&format!("{n}. "))),
            Block::Quote(text) => push(&strip_inline(&text), 11.0, false, 18.0, 6.0, None),
            Block::Code(code) => {
                for (i, l) in code.lines().enumerate() {
                    push_wrapped(wrap_code(if l.is_empty() { " " } else { l }, 9.5, width - 12.0), 9.5, false, 12.0, if i == 0 { 6.0 } else { 0.0 }, None);
                }
            }
            Block::Rule => push(" ", 6.0, false, 0.0, 6.0, None),
        }
    }
    lines
}

fn pdf_string(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 2);
    out.push('(');
    for &b in bytes {
        match b {
            b'(' | b')' | b'\\' => {
                out.push('\\');
                out.push(b as char);
            }
            0x20..=0x7E => out.push(b as char),
            _ => {
                let _ = write!(out, "\\{b:03o}");
            }
        }
    }
    out.push(')');
    out
}

fn to_pdf(title: &str, markdown: &str) -> Vec<u8> {
    // Lay lines out on pages.
    let mut pages: Vec<String> = Vec::new();
    let mut content = String::new();
    let mut y = PAGE_H - MARGIN;
    for line in layout(title, markdown) {
        let leading = line.size * 1.38;
        if y - line.gap - leading < MARGIN && !content.is_empty() {
            pages.push(std::mem::take(&mut content));
            y = PAGE_H - MARGIN;
        } else {
            y -= line.gap;
        }
        y -= leading;
        let font = if line.bold { "F2" } else { "F1" };
        let _ = writeln!(content, "BT /{font} {:.1} Tf {:.2} {:.2} Td {} Tj ET", line.size, MARGIN + line.indent, y, pdf_string(&line.text));
    }
    if !content.is_empty() || pages.is_empty() {
        pages.push(content);
    }
    let total = pages.len();
    for (i, page) in pages.iter_mut().enumerate() {
        let number = format!("{} / {}", i + 1, total);
        let _ = writeln!(page, "BT /F1 8.5 Tf {:.2} {:.2} Td 0.55 g {} Tj ET", PAGE_W - MARGIN - 30.0, MARGIN / 2.0, pdf_string(number.as_bytes()));
    }

    // Objects: 1 catalog, 2 pages, 3–4 fonts, 5 info, then a page and its content per page.
    let mut objects: Vec<String> = vec![String::new(); 5];
    let kids: Vec<String> = (0..total).map(|i| format!("{} 0 R", 6 + i * 2)).collect();
    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>".into();
    objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {total} >>", kids.join(" "));
    objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into();
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".into();
    let title_bytes: Vec<u8> = title.chars().map(cp1252).collect();
    objects[4] = format!("<< /Title {} /Producer (NOVA AI) >>", pdf_string(&title_bytes));
    for (i, page) in pages.iter().enumerate() {
        let content_id = 7 + i * 2;
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {content_id} 0 R >>"
        ));
        objects.push(format!("<< /Length {} >>\nstream\n{page}endstream", page.len()));
    }

    let mut pdf: Vec<u8> = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (i, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
    }
    let xref = pdf.len();
    let mut tail = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
    for offset in offsets {
        // Each entry is exactly 20 bytes: offset, generation, "n", space, newline.
        let _ = writeln!(tail, "{offset:010} 00000 n ");
    }
    let _ = write!(tail, "trailer\n<< /Size {} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1);
    pdf.extend_from_slice(tail.as_bytes());
    pdf
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "## Überblick\n\nDer **3D-Drucker** kostet 249 € – „gut“.\n\n- Erster Punkt\n- Zweiter Punkt\n\n1. Eins\n2. Zwei\n\n```\nlet x = 1;\n```\n\n> Zitat";

    /// A zip file with one uncompressed entry, as small as a Word document can be.
    fn zip_with(name: &str, content: &str) -> Vec<u8> {
        let (name, content) = (name.as_bytes(), content.as_bytes());
        let size = (content.len() as u32).to_le_bytes();
        let name_len = (name.len() as u16).to_le_bytes();
        let mut file = b"PK\x03\x04".to_vec();
        file.extend([0u8; 22]);
        file.extend(name_len);
        file.extend([0u8; 2]);
        file.extend(name);
        file.extend(content);
        let central = file.len() as u32;
        file.extend(b"PK\x01\x02");
        file.extend([0u8; 16]);
        file.extend(size);
        file.extend(size);
        file.extend(name_len);
        file.extend([0u8; 16]);
        file.extend(name);
        file.extend(b"PK\x05\x06");
        file.extend([0u8; 4]);
        file.extend([1, 0, 1, 0]);
        file.extend([0u8; 4]);
        file.extend(central.to_le_bytes());
        file.extend([0u8; 2]);
        file
    }

    #[test]
    fn reads_the_text_of_a_word_document() {
        let xml = "<w:document><w:body><w:p><w:r><w:t>Erste Zeile &amp; mehr</w:t></w:r></w:p><w:p><w:r><w:t>Zweite Zeile</w:t></w:r></w:p></w:body></w:document>";
        assert_eq!(docx_text(&zip_with("word/document.xml", xml)).unwrap(), "Erste Zeile & mehr\nZweite Zeile");
    }

    #[test]
    fn a_broken_word_document_is_an_error_and_never_a_crash() {
        assert!(docx_text(&zip_with("anderes.xml", "x")).is_err());
        assert!(docx_text(b"gar kein zip").is_err());
        assert!(docx_text(b"PK\x05\x06").is_err());
        let good = zip_with("word/document.xml", "<w:p>Text</w:p>");
        for cut in 0..good.len() {
            let _ = docx_text(&good[..cut]);
        }
        for at in 0..good.len() {
            let mut bad = good.clone();
            bad[at] = 0xFF;
            let _ = docx_text(&bad);
        }
    }

    #[test]
    fn removes_only_real_emphasis_and_keeps_code_indentation() {
        assert_eq!(strip_inline("Der **3D-Drucker** ist *gut*"), "Der 3D-Drucker ist gut");
        assert_eq!(strip_inline("3 * 4 * 5"), "3 * 4 * 5");
        assert_eq!(strip_inline("ein * allein"), "ein * allein");
        assert_eq!(strip_inline("**offen"), "**offen");
        assert_eq!(wrap_code("\tif x:", 9.5, 400.0), vec![b"    if x:".to_vec()]);
        assert!(wrap_code(&"x".repeat(50), 9.5, 50.0).len() > 1);
    }

    #[test]
    fn makes_safe_file_names() {
        assert_eq!(safe_file_stem("Report: Q3/Q4 *final*?"), "Report Q3 Q4 final");
        assert_eq!(safe_file_stem("..."), "NOVA document");
        assert_eq!(safe_file_stem("CON"), "NOVA document");
        assert_eq!(safe_file_stem(&"x".repeat(200)).len(), 80);
    }

    #[test]
    fn parses_the_markdown_subset() {
        let blocks = parse_blocks(SAMPLE);
        assert_eq!(blocks[0], Block::Heading(2, "Überblick".into()));
        assert!(matches!(&blocks[1], Block::Paragraph(p) if p.contains("249 €")));
        assert_eq!(blocks[2], Block::Bullet("Erster Punkt".into()));
        assert_eq!(blocks[4], Block::Numbered("1".into(), "Eins".into()));
        assert_eq!(blocks[6], Block::Code("let x = 1;".into()));
        assert_eq!(blocks[7], Block::Quote("Zitat".into()));
    }

    #[test]
    fn renders_html_safely() {
        let html = to_html("Test <script>", "Hello **world** and [link](https://example.com) and [bad](javascript:alert(1))\n\n- a\n- b");
        assert!(html.contains("<title>Test &lt;script&gt;</title>"));
        assert!(html.contains("<strong>world</strong>"));
        assert!(html.contains(r#"<a href="https://example.com">link</a>"#));
        assert!(!html.contains("href=\"javascript"));
        assert!(html.contains("<ul>\n<li>a</li>\n<li>b</li>\n</ul>"));
    }

    #[test]
    fn encodes_windows_1252() {
        assert_eq!(cp1252('ü'), 0xFC);
        assert_eq!(cp1252('€'), 0x80);
        assert_eq!(cp1252('„'), 0x84);
        assert_eq!(cp1252('漢'), b'?');
        assert_eq!(pdf_string(&[b'(', 0xFC, b')']), "(\\(\\374\\))");
    }

    #[test]
    fn wraps_lines_to_the_page_width() {
        let lines = wrap(&"word ".repeat(200), 11.0, false, 400.0);
        assert!(lines.len() > 5);
        for line in &lines {
            let width: f32 = line.iter().map(|b| glyph_width(*b, false) as f32).sum::<f32>() * 11.0 / 1000.0;
            assert!(width <= 400.0 + 0.01);
        }
    }

    #[test]
    fn writes_a_structurally_valid_pdf() {
        let pdf = to_pdf("Bericht", &format!("{SAMPLE}\n\n{}", "Ein langer Absatz mit vielen Wörtern. ".repeat(400)));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.starts_with("%PDF-1.4"));
        assert!(text.trim_end().ends_with("%%EOF"));
        let pages = text.matches("/Type /Page ").count();
        assert!(pages >= 2, "long text spans pages, got {pages}");
        assert!(text.contains(&format!("/Count {pages}")));
        // Every xref offset points at its object.
        let xref_at: usize = text.rsplit("startxref\n").next().unwrap().lines().next().unwrap().parse().unwrap();
        // Offsets are bytes; the binary marker line makes the lossy text longer.
        let xref = String::from_utf8_lossy(&pdf[xref_at..]);
        assert!(xref.starts_with("xref\n"));
        for (i, line) in xref.lines().skip(3).take(5).enumerate() {
            let offset: usize = line[..10].parse().unwrap();
            assert!(pdf[offset..].starts_with(format!("{} 0 obj", i + 1).as_bytes()), "object {} misplaced", i + 1);
        }
    }

    #[test]
    fn saves_documents_without_overwriting() {
        let dir = std::env::temp_dir().join(format!("nova-docs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = create("Plan", Format::Md, "Hallo", Some(&dir)).unwrap();
        let second = create("Plan", Format::Md, "Hallo", Some(&dir)).unwrap();
        assert_eq!(first.name, "Plan.md");
        assert_eq!(second.name, "Plan (2).md");
        assert_eq!(std::fs::read_to_string(&first.path).unwrap(), "# Plan\n\nHallo\n");
        let txt = create("Notiz", Format::Txt, "- a\n- b", Some(&dir)).unwrap();
        assert_eq!(std::fs::read_to_string(&txt.path).unwrap(), "Notiz\r\n=====\r\n\r\n• a\r\n• b\r\n");
        assert!(create("  ", Format::Pdf, "x", Some(&dir)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
