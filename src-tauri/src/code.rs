//! Built-in IDE: read/write text files (with an on-disk change check), `terraform fmt` with
//! syntax errors, and git data for the side panel (commit graph, diffs).

use crate::{editor::expand, store::err};
use serde::Serialize;
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::UNIX_EPOCH,
};

const MAX_FILE: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileText {
    text: String,
    /// modification time in ms; sent back on save to detect edits made elsewhere
    mtime: u64,
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

#[tauri::command]
pub async fn code_read(path: String) -> Result<FileText, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = expand(&path);
        let meta = std::fs::metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        if meta.len() > MAX_FILE {
            return Err(format!("файл больше {} МБ — откройте его во внешнем редакторе", MAX_FILE / 1024 / 1024));
        }
        let bytes = std::fs::read(&p).map_err(err)?;
        if bytes.iter().take(8000).any(|b| *b == 0) {
            return Err("двоичный файл — не открывается в редакторе".into());
        }
        Ok(FileText { text: String::from_utf8_lossy(&bytes).into_owned(), mtime: mtime_ms(&p) })
    })
    .await
    .map_err(err)?
}

/// Save; refuses when the file changed on disk after `expect_mtime` (unless `force`). Returns the new mtime.
#[tauri::command]
pub async fn code_write(path: String, text: String, expect_mtime: Option<u64>, force: bool) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = expand(&path);
        if let (Some(exp), false) = (expect_mtime, force) {
            let now = mtime_ms(&p);
            if now != 0 && now != exp {
                return Err("CONFLICT: файл изменён на диске после открытия".into());
            }
        }
        // keep the original permissions: write in place
        std::fs::write(&p, text).map_err(|e| format!("{}: {e}", p.display()))?;
        Ok(mtime_ms(&p))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn code_create(path: String, dir: bool) -> Result<(), String> {
    let p = expand(&path);
    if p.exists() {
        return Err(format!("{} уже существует", p.display()));
    }
    if dir {
        std::fs::create_dir_all(&p).map_err(err)
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        std::fs::write(&p, "").map_err(err)
    }
}

// ---------- terraform fmt ----------

#[derive(Serialize)]
pub struct Diag {
    line: u32,
    message: String,
}

#[derive(Serialize)]
pub struct FmtResult {
    /// formatted text when the file is valid
    text: Option<String>,
    errors: Vec<Diag>,
    /// "terraform" / "tofu", empty when neither is installed
    tool: String,
}

fn find_tool() -> Option<String> {
    ["terraform", "tofu"].into_iter().find(|t| Command::new(t).arg("version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok()).map(str::to_string)
}

/// `terraform fmt -` on the buffer: formatted text, or the syntax errors with line numbers.
#[tauri::command]
pub async fn code_tf_fmt(text: String) -> Result<FmtResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(tool) = find_tool() else { return Ok(FmtResult { text: None, errors: Vec::new(), tool: String::new() }) };
        let mut child = Command::new(&tool)
            .args(["fmt", "-no-color", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{tool}: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("stdin")?;
        let input = text.clone();
        let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
        let out = child.wait_with_output().map_err(err)?;
        let _ = writer.join();
        if out.status.success() {
            return Ok(FmtResult { text: Some(String::from_utf8_lossy(&out.stdout).into_owned()), errors: Vec::new(), tool });
        }
        Ok(FmtResult { text: None, errors: parse_tf_errors(&String::from_utf8_lossy(&out.stderr)), tool })
    })
    .await
    .map_err(err)?
}

/// Terraform diagnostics: "Error: <summary>" … "on <stdin> line N" … details.
fn parse_tf_errors(stderr: &str) -> Vec<Diag> {
    let mut out = Vec::new();
    let mut cur: Option<(String, u32, Vec<String>)> = None;
    let flush = |cur: &mut Option<(String, u32, Vec<String>)>, out: &mut Vec<Diag>| {
        if let Some((summary, line, detail)) = cur.take() {
            let detail = detail.join(" ").trim().to_string();
            out.push(Diag { line: line.max(1), message: if detail.is_empty() { summary } else { format!("{summary}: {detail}") } });
        }
    };
    for raw in stderr.lines() {
        let l = raw.trim_start_matches(['│', '╷', '╵', ' ']).trim_end();
        if let Some(s) = l.strip_prefix("Error: ") {
            flush(&mut cur, &mut out);
            cur = Some((s.to_string(), 0, Vec::new()));
        } else if let Some((_, _, detail)) = cur.as_mut() {
            if let Some(rest) = l.trim_start().strip_prefix("on <stdin> line ") {
                let n: u32 = rest.split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()).unwrap_or(0);
                cur.as_mut().unwrap().1 = n;
            } else if !l.is_empty() && !l.trim_start().chars().next().is_some_and(|c| c.is_ascii_digit()) {
                detail.push(l.trim().to_string());
            }
        }
    }
    flush(&mut cur, &mut out);
    if out.is_empty() && !stderr.trim().is_empty() {
        out.push(Diag { line: 1, message: stderr.trim().to_string() });
    }
    out
}

// ---------- git ----------

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).stdin(Stdio::null()).output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Serialize)]
pub struct Commit {
    hash: String,
    parents: Vec<String>,
    /// "HEAD -> master", "origin/master", "tag: v1.0"
    refs: Vec<String>,
    author: String,
    time: i64,
    subject: String,
}

/// Commits of all branches, newest first, for the graph.
#[tauri::command]
pub async fn code_git_log(path: String, limit: Option<usize>) -> Result<Vec<Commit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&path);
        let n = limit.unwrap_or(300).min(2000).to_string();
        let text = git(&dir, &["log", "--all", "--date-order", "-n", &n, "--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e"])?;
        Ok(text
            .split('\x1e')
            .filter_map(|rec| {
                let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
                (f.len() == 6).then(|| Commit {
                    hash: f[0].to_string(),
                    parents: f[1].split_whitespace().map(str::to_string).collect(),
                    refs: f[2].split(", ").filter(|r| !r.is_empty()).map(str::to_string).collect(),
                    author: f[3].to_string(),
                    time: f[4].parse().unwrap_or(0),
                    subject: f[5].to_string(),
                })
            })
            .collect())
    })
    .await
    .map_err(err)?
}

/// Unified diff of a working-tree file against HEAD (untracked: the whole file as added).
#[tauri::command]
pub async fn code_git_diff(root: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&root);
        let d = git(&dir, &["diff", "--no-color", "HEAD", "--", &file])?;
        if !d.trim().is_empty() {
            return Ok(d);
        }
        // untracked or new: diff against /dev/null (exit code 1 means "differs")
        let out = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["diff", "--no-color", "--no-index", "--", "/dev/null", &file])
            .stdin(Stdio::null())
            .output()
            .map_err(err)?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
    .map_err(err)?
}

/// One commit: header, stat and patch (trimmed for huge commits).
#[tauri::command]
pub async fn code_git_show(root: String, hash: String) -> Result<String, String> {
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) || hash.len() < 7 {
        return Err("bad hash".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = git(&expand(&root), &["show", "--no-color", "--stat", "--patch", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B", &hash])?;
        if s.len() > 400_000 {
            s.truncate(400_000);
            s.push_str("\n… (обрезано)");
        }
        Ok(s)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terraform_errors() {
        let stderr = "╷\n│ Error: Invalid expression\n│ \n│   on <stdin> line 3, in resource \"x\" \"y\":\n│    3:   ami = \n│ \n│ Expected the start of an expression, but found an invalid expression token.\n╵\n";
        let d = parse_tf_errors(stderr);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].line, 3);
        assert!(d[0].message.starts_with("Invalid expression: Expected the start"));
    }
}
