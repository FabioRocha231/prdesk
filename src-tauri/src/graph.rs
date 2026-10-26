use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::workspace::local;

/// Rows beyond this make the graph unreadable and the log slow on big repos.
const MAX_COMMITS: u32 = 500;
const FIELD: char = '\x1f';
const RECORD: char = '\x1e';

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    hash: String,
    parents: Vec<String>,
    /// Decorations as git prints them: "HEAD -> main", "origin/main", "tag: v1.2".
    refs: Vec<String>,
    subject: String,
    author: String,
    /// Unix seconds.
    time: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    /// `origin`'s URL, to match branches with the PRs on the board.
    remote: Option<String>,
    commits: Vec<GraphCommit>,
}

fn parse(log: &str) -> Vec<GraphCommit> {
    log.split(RECORD)
        .filter_map(|record| {
            let mut f = record.trim_start_matches('\n').split(FIELD);
            let hash = f.next().filter(|h| !h.is_empty())?.to_owned();
            let parents = f.next()?.split_whitespace().map(str::to_owned).collect();
            let refs = f
                .next()?
                .split(", ")
                .filter(|r| !r.is_empty())
                .map(str::to_owned)
                .collect();
            let subject = f.next()?.to_owned();
            let author = f.next()?.to_owned();
            let time = f.next()?.trim().parse().ok()?;
            Some(GraphCommit {
                hash,
                parents,
                refs,
                subject,
                author,
                time,
            })
        })
        .collect()
}

/// `git log` over `revs` (already validated) in topological order, newest first.
pub(crate) fn read_graph(tree: &Path, revs: &[&str], limit: u32) -> Result<Graph, String> {
    let max = format!("--max-count={}", limit.clamp(1, MAX_COMMITS));
    let format = format!("--format=%H{FIELD}%P{FIELD}%D{FIELD}%s{FIELD}%an{FIELD}%ct{RECORD}");
    let mut args = vec!["log", "--topo-order", "--decorate=short", &max, &format];
    args.extend_from_slice(revs);
    // Revisions only; nothing after this can be read as a path.
    args.push("--");
    let log = local(tree, &args)?;
    let remote = local(tree, &["remote", "get-url", "origin"])
        .ok()
        .map(|u| u.trim().to_owned());
    Ok(Graph {
        remote,
        commits: parse(&log),
    })
}

/// The repository that contains `path`, which the user picked in a folder dialog.
fn repo_root(path: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(path);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("Choose an existing folder.".into());
    }
    let top = local(&dir, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "This folder is not inside a git repository.".to_owned())?;
    Ok(PathBuf::from(top.trim()))
}

/// Folders a workspace scan never descends into: dependencies, build output, hidden dirs.
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "dist", "vendor"];
const MAX_REPOS: usize = 60;
const SCAN_DEPTH: u32 = 2;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    path: String,
    name: String,
    /// `origin`'s URL, to match the repo with the PRs on the board before reading its history.
    remote: Option<String>,
}

fn is_repo(dir: &Path) -> bool {
    // A file (not a dir) for worktrees and submodules; both are repos worth drawing.
    dir.join(".git").exists()
}

fn scan(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_REPOS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref())
        })
        .map(|e| e.path())
        .collect();
    children.sort();
    for child in children {
        if out.len() >= MAX_REPOS {
            return;
        }
        if is_repo(&child) {
            out.push(child);
        } else if depth > 1 {
            scan(&child, depth - 1, out);
        }
    }
}

/// The repositories in a folder: the folder itself when it is one, else every repo up to two levels below it.
#[tauri::command]
pub async fn git_repos(path: String) -> Result<Vec<RepoEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&path);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err("Choose an existing folder.".into());
        }
        let mut found = Vec::new();
        if is_repo(&dir) {
            found.push(dir.clone());
        } else {
            scan(&dir, SCAN_DEPTH, &mut found);
        }
        Ok(found
            .into_iter()
            .filter_map(|repo| {
                let remote = local(&repo, &["config", "--get", "remote.origin.url"])
                    .ok()
                    .map(|u| u.trim().to_owned());
                let name = repo
                    .strip_prefix(&dir)
                    .ok()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(&repo)
                    .to_string_lossy()
                    .into_owned();
                Some(RepoEntry {
                    path: repo.to_str()?.to_owned(),
                    name,
                    remote,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Scan task failed: {e}"))?
}

/// Every branch, remote branch and tag of a local repository.
#[tauri::command]
pub async fn git_graph(path: String, limit: u32) -> Result<Graph, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&path)?;
        read_graph(&root, &["--branches", "--remotes", "--tags"], limit)
    })
    .await
    .map_err(|e| format!("Graph task failed: {e}"))?
}

/// Updates the remote branches of a local repository with the user's own git credentials.
#[tauri::command]
pub async fn git_fetch(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&path)?;
        // ponytail: no timeout; a hung remote leaves the "Atualizar" spinner on until git gives up.
        let out = std::process::Command::new("git")
            .current_dir(&root)
            .args(["fetch", "--all", "--prune", "--quiet"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("Could not run git: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        eprintln!(
            "[graph.git_fetch] fetch failed in {}: {stderr}",
            root.display()
        );
        Err(format!("git fetch failed: {}", stderr.trim()))
    })
    .await
    .map_err(|e| format!("Fetch task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_two_levels_and_skips_dependencies() {
        let root = std::env::temp_dir().join(format!("prdesk-scan-{}", std::process::id()));
        for dir in [
            "a/.git",
            "group/b/.git",
            "group/node_modules/c/.git",
            "deep/x/y/.git",
            ".hidden/.git",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let mut found = Vec::new();
        scan(&root, SCAN_DEPTH, &mut found);
        let names: Vec<String> = found
            .iter()
            .map(|p| {
                p.strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(names, vec!["a", "group/b"]);
    }

    #[test]
    fn parses_records_with_merges_and_decorations() {
        let log = "a\x1fb c\x1fHEAD -> main, origin/main, tag: v1\x1fMerge pull request #12 from x/y\x1fAna\x1f1700000000\x1e\nb\x1f\x1f\x1froot\x1fBia\x1f1600000000\x1e\n";
        let commits = parse(log);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["b", "c"]);
        assert_eq!(
            commits[0].refs,
            vec!["HEAD -> main", "origin/main", "tag: v1"]
        );
        assert!(commits[1].parents.is_empty() && commits[1].refs.is_empty());
        assert_eq!(commits[1].time, 1_600_000_000);
    }
}
