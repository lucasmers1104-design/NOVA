//! Downloads for NOVA's speech items: streamed to disk with the SHA-256
//! checked as the bytes arrive, or one file taken out of a zip archive (a
//! NuGet package) with ranged requests, so a 200 MB package costs only the
//! few megabytes NOVA needs from it.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::catalog::File;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// SHA-256 of a file on disk.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Downloads `file` to `dest`; `progress` gets the bytes received so far.
pub async fn fetch(file: &File, dest: &Path, progress: &(dyn Fn(u64) + Sync)) -> Result<(), String> {
    match file.zip_entry {
        Some(entry) => fetch_zip_entry(file, entry, dest, progress).await,
        None => fetch_whole(file, dest, progress).await,
    }
}

/// Hashes what an earlier, interrupted attempt left, so the download can go on from there.
fn resume_from(partial: &Path, limit: u64) -> Option<(Sha256, u64)> {
    let len = std::fs::metadata(partial).ok()?.len();
    if len == 0 || len >= limit {
        return None;
    }
    let mut file = std::fs::File::open(partial).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Some((hasher, len))
}

async fn fetch_whole(file: &File, dest: &Path, progress: &(dyn Fn(u64) + Sync)) -> Result<(), String> {
    let partial = dest.with_extension("part");
    let earlier = resume_from(&partial, file.size);
    let mut request = crate::http::client().get(file.url).timeout(Duration::from_secs(6 * 3600));
    if let Some((_, len)) = &earlier {
        request = request.header("Range", format!("bytes={len}-"));
    }
    let mut response = request.send().await.map_err(crate::http::describe)?;
    if !response.status().is_success() {
        return Err(format!("The download server answered {}", response.status()));
    }
    // Only a partial answer continues the earlier attempt; anything else starts over.
    let (mut hasher, mut received, append) = match earlier {
        Some((hasher, len)) if response.status() == reqwest::StatusCode::PARTIAL_CONTENT => (hasher, len, true),
        _ => (Sha256::new(), 0u64, false),
    };
    let opened = if append { std::fs::OpenOptions::new().append(true).open(&partial) } else { std::fs::File::create(&partial) };
    let mut out = std::io::BufWriter::new(opened.map_err(|e| format!("Couldn't write {}: {e}", partial.display()))?);
    progress(received);
    let result: Result<(), String> = async {
        while let Some(chunk) = response.chunk().await.map_err(crate::http::describe)? {
            received += chunk.len() as u64;
            if received > file.size {
                return Err("The download is larger than expected".into());
            }
            hasher.update(&chunk);
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            progress(received);
        }
        out.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    drop(out);
    if let Err(error) = result {
        // A dropped connection keeps what arrived for the next attempt; a wrong file doesn't.
        if received > file.size {
            let _ = std::fs::remove_file(&partial);
        }
        return Err(error);
    }
    if hex(&hasher.finalize()) != file.sha256 {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("{} didn't match (checksum differs)", file.name));
    }
    std::fs::rename(&partial, dest).map_err(|e| e.to_string())
}

/// Bytes `start..=end` of `url` (or the last `-start` bytes when `end` is None).
async fn range(url: &str, start: i64, end: Option<u64>, progress: Option<&(dyn Fn(u64) + Sync)>) -> Result<(Vec<u8>, u64), String> {
    let header = match end {
        Some(end) => format!("bytes={start}-{end}"),
        None => format!("bytes={start}"),
    };
    let mut response = crate::http::client().get(url).header("Range", header).timeout(Duration::from_secs(3600)).send().await.map_err(crate::http::describe)?;
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("The download server doesn't send parts of files ({})", response.status()));
    }
    let total = response
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or("The download server sent no file size")?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(crate::http::describe)? {
        if body.len() + chunk.len() > 256 << 20 {
            return Err("A part of the download is larger than expected".into());
        }
        body.extend_from_slice(&chunk);
        if let Some(progress) = progress {
            progress(body.len() as u64);
        }
    }
    Ok((body, total))
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Where an entry's data sits in the archive, from its central directory.
#[derive(Debug, PartialEq)]
struct Entry {
    method: u16,
    compressed: u64,
    size: u64,
    local_header: u64,
}

/// Finds the central directory in the archive's tail: (offset, size).
fn central_directory(tail: &[u8]) -> Option<(u64, u64)> {
    let at = (0..tail.len().saturating_sub(21)).rev().find(|&i| u32_at(tail, i) == Some(0x0605_4b50))?;
    let size = u32_at(tail, at + 12)?;
    let offset = u32_at(tail, at + 16)?;
    // Zip64 archives (over 4 GB) aren't needed here.
    (size != u32::MAX && offset != u32::MAX).then_some((offset as u64, size as u64))
}

fn find_entry(directory: &[u8], name: &str) -> Option<Entry> {
    let mut at = 0;
    while u32_at(directory, at) == Some(0x0201_4b50) {
        let method = u16_at(directory, at + 10)?;
        let compressed = u32_at(directory, at + 20)? as u64;
        let size = u32_at(directory, at + 24)? as u64;
        let name_len = u16_at(directory, at + 28)? as usize;
        let extra_len = u16_at(directory, at + 30)? as usize;
        let comment_len = u16_at(directory, at + 32)? as usize;
        let local_header = u32_at(directory, at + 42)? as u64;
        let entry_name = directory.get(at + 46..at + 46 + name_len)?;
        if entry_name == name.as_bytes() {
            return Some(Entry { method, compressed, size, local_header });
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    None
}

fn inflate(method: u16, data: &[u8], size: u64) -> Result<Vec<u8>, String> {
    match method {
        0 => Ok(data.to_vec()),
        8 => {
            let mut out = Vec::with_capacity(size as usize);
            flate2::read::DeflateDecoder::new(data).take(size + 1).read_to_end(&mut out).map_err(|e| format!("Couldn't unpack the download: {e}"))?;
            Ok(out)
        }
        other => Err(format!("The archive uses an unknown compression ({other})")),
    }
}

async fn fetch_zip_entry(file: &File, name: &str, dest: &Path, progress: &(dyn Fn(u64) + Sync)) -> Result<(), String> {
    // The size first: GitHub's download servers refuse "the last n bytes".
    let (_, total) = range(file.url, 0, Some(0), None).await?;
    let (tail, _) = range(file.url, total.saturating_sub(65_536 + 22) as i64, Some(total.saturating_sub(1)), None).await?;
    let (offset, size) = central_directory(&tail).ok_or("The archive has no directory")?;
    // The directory is usually inside the tail already.
    let tail_start = total.saturating_sub(tail.len() as u64);
    let directory = if offset >= tail_start {
        tail[(offset - tail_start) as usize..].to_vec()
    } else {
        range(file.url, offset as i64, Some(offset + size - 1), None).await?.0
    };
    let entry = find_entry(&directory, name).ok_or_else(|| format!("The archive has no {name}"))?;
    if entry.size != file.size {
        return Err(format!("{name} has an unexpected size"));
    }
    let (local, _) = range(file.url, entry.local_header as i64, Some(entry.local_header + 29), None).await?;
    let data_start = entry.local_header + 30 + u16_at(&local, 26).ok_or("Bad archive")? as u64 + u16_at(&local, 28).ok_or("Bad archive")? as u64;
    let (data, _) = range(file.url, data_start as i64, Some(data_start + entry.compressed - 1), Some(&|n| progress(n * file.size / entry.compressed.max(1)))).await?;
    let bytes = inflate(entry.method, &data, entry.size)?;
    if bytes.len() as u64 != file.size || sha256_hex(&bytes) != file.sha256 {
        return Err(format!("{} didn't match (checksum differs)", file.name));
    }
    let partial = dest.with_extension("part");
    std::fs::write(&partial, &bytes).map_err(|e| format!("Couldn't write {}: {e}", partial.display()))?;
    std::fs::rename(&partial, dest).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-file zip archive, deflated, as `zip` would write it.
    fn archive(name: &str, content: &[u8]) -> Vec<u8> {
        let mut deflated = Vec::new();
        let mut encoder = flate2::write::DeflateEncoder::new(&mut deflated, flate2::Compression::default());
        encoder.write_all(content).unwrap();
        encoder.finish().unwrap();
        let mut zip = Vec::new();
        let local = |zip: &mut Vec<u8>| {
            zip.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            zip.extend_from_slice(&[20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            zip.extend_from_slice(&(deflated.len() as u32).to_le_bytes());
            zip.extend_from_slice(&(content.len() as u32).to_le_bytes());
            zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
            zip.extend_from_slice(&0u16.to_le_bytes());
            zip.extend_from_slice(name.as_bytes());
            zip.extend_from_slice(&deflated);
        };
        local(&mut zip);
        let directory_at = zip.len() as u32;
        zip.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        zip.extend_from_slice(&(deflated.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(content.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
        zip.extend_from_slice(&[0; 12]);
        zip.extend_from_slice(&0u32.to_le_bytes());
        zip.extend_from_slice(name.as_bytes());
        let directory_size = zip.len() as u32 - directory_at;
        zip.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0]);
        zip.extend_from_slice(&directory_size.to_le_bytes());
        zip.extend_from_slice(&directory_at.to_le_bytes());
        zip.extend_from_slice(&[0, 0]);
        zip
    }

    #[test]
    fn finds_and_unpacks_one_entry() {
        let content = b"NOVA speaks German. NOVA speaks German. NOVA speaks German.";
        let zip = archive("runtimes/win-x64/native/x.dll", content);
        let (offset, size) = central_directory(&zip).unwrap();
        let entry = find_entry(&zip[offset as usize..(offset + size) as usize], "runtimes/win-x64/native/x.dll").unwrap();
        assert_eq!(entry.size, content.len() as u64);
        assert!(find_entry(&zip[offset as usize..], "other.dll").is_none());
        let local = entry.local_header as usize;
        let start = local + 30 + u16_at(&zip, local + 26).unwrap() as usize + u16_at(&zip, local + 28).unwrap() as usize;
        let data = &zip[start..start + entry.compressed as usize];
        assert_eq!(inflate(entry.method, data, entry.size).unwrap(), content);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
