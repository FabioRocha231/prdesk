use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::auth::{self, TokenCache};
use crate::graph;

const DEFAULT_DIR: &str = "PRDesk";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRequest {
    /// e.g. https://github.com/owner/repo
    repo_url: String,
    owner: String,
    repo: String,
    number: u32,
    head_ref: String,
    is_cross_repository: bool,
    /// Fetched too, so the agent can merge or diff against it without network access.
    #[serde(default)]
    base_ref: Option<String>,
    /// Empty means ~/PRDesk.
    workspace_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRequest {
    repo_url: String,
    owner: String,
    repo: String,
    branch: String,
    workspace_dir: String,
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// Subset of `git check-ref-format`: enough to keep the ref from being read as an option or a path trick.
fn valid_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with('-')
        && !s.contains("..")
        && !s.ends_with(".lock")
        && !s
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
}

pub(crate) fn workspace_root(dir: &str) -> Result<PathBuf, String> {
    if dir.is_empty() {
        return dirs::home_dir()
            .map(|h| h.join(DEFAULT_DIR))
            .ok_or("No home directory.".into());
    }
    let path = PathBuf::from(dir);
    if !path.is_absolute() {
        return Err("The workspace folder must be an absolute path.".into());
    }
    Ok(path)
}

/// Runs git with the token scoped to the repo's host via env config, so it never lands in argv or .git/config.
/// Returns stdout.
fn git(cwd: Option<&Path>, origin: &str, token: &str, args: &[&str]) -> Result<String, String> {
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let mut cmd = crate::command("git");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", format!("http.{origin}.extraheader"))
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("AUTHORIZATION: basic {basic}"),
        )
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    eprintln!(
        "[workspace.git] git {} failed: {stderr}",
        args.first().unwrap_or(&"")
    );
    Err(format!(
        "git {} failed: {}",
        args.first().unwrap_or(&""),
        stderr.trim()
    ))
}

/// Local-only git (status, diff): no network, so no token header.
pub(crate) fn local(tree: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::command("git")
        .current_dir(tree)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// "https://github.com/owner/repo" → "https://github.com/", the scope the token header is limited to.
fn origin_of(repo_url: &str) -> Result<String, String> {
    let rest = repo_url
        .strip_prefix("https://")
        .ok_or("The repository URL must use https.")?;
    let host = rest
        .split('/')
        .next()
        .filter(|h| !h.is_empty())
        .ok_or("Invalid repository URL.")?;
    Ok(format!("https://{host}/"))
}

/// Agent context files live in `<worktree>/.prdesk/`; the shared exclude keeps them out of status and commits.
pub(crate) fn exclude_prdesk(tree: &Path) -> Result<(), String> {
    let common = local(tree, &["rev-parse", "--git-common-dir"])?;
    let common = tree.join(common.trim());
    let info = common.join("info");
    let exclude = info.join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == ".prdesk/") {
        return Ok(());
    }
    std::fs::create_dir_all(&info).map_err(|e| format!("Could not update git excludes: {e}"))?;
    std::fs::write(&exclude, format!("{current}\n.prdesk/\n"))
        .map_err(|e| format!("Could not update git excludes: {e}"))
}

struct Clone {
    origin: String,
    root: PathBuf,
    base: PathBuf,
}

/// Clones `owner/repo` once (blobless) into the workspace and returns where it lives.
fn ensure_clone(
    repo_url: &str,
    owner: &str,
    repo: &str,
    workspace_dir: &str,
    token: &str,
) -> Result<Clone, String> {
    if !valid_segment(owner) || !valid_segment(repo) {
        return Err("Unexpected repository name.".into());
    }
    let origin = origin_of(repo_url)?;
    let clone_url = format!("{origin}{owner}/{repo}.git");
    let root = workspace_root(workspace_dir)?.join(owner);
    let base = root.join(repo);
    if !base.join(".git").exists() {
        std::fs::create_dir_all(&root)
            .map_err(|e| format!("Could not create {}: {e}", root.display()))?;
        let base_str = base.to_str().ok_or("Workspace path is not valid UTF-8.")?;
        git(
            None,
            &origin,
            token,
            &["clone", "--filter=blob:none", "--", &clone_url, base_str],
        )?;
    }
    Ok(Clone { origin, root, base })
}

fn fetch_branch(clone: &Clone, token: &str, branch: &str) -> Result<(), String> {
    let spec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    git(
        Some(&clone.base),
        &clone.origin,
        token,
        &["fetch", "origin", &spec],
    )
    .map(|_| ())
}

fn path_str(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or("Workspace path is not valid UTF-8.".into())
}

fn prepare(req: &WorktreeRequest, token: &str) -> Result<String, String> {
    if !valid_ref(&req.head_ref) {
        return Err("Unexpected branch name.".into());
    }
    let clone = ensure_clone(
        &req.repo_url,
        &req.owner,
        &req.repo,
        &req.workspace_dir,
        token,
    )?;
    let (origin, base) = (&clone.origin, &clone.base);
    let tree = clone.root.join(format!("{}-pr-{}", req.repo, req.number));
    let tree_str = path_str(&tree)?;

    if let Some(base_ref) = req.base_ref.as_deref().filter(|b| valid_ref(b)) {
        // Best effort: without it the agent can still work, it just cannot merge the base offline.
        let _ = fetch_branch(&clone, token, base_ref);
    }

    if tree.exists() {
        // Best effort: local edits or a diverged branch must not block opening the agent.
        let _ = git(Some(&tree), origin, token, &["pull", "--ff-only"]);
        exclude_prdesk(&tree)?;
        return Ok(tree_str);
    }

    if req.is_cross_repository {
        let local = format!("prdesk/pr-{}", req.number);
        let spec = format!("+refs/pull/{}/head:refs/heads/{local}", req.number);
        git(Some(base), origin, token, &["fetch", "origin", &spec])?;
        git(
            Some(base),
            origin,
            token,
            &["worktree", "add", "--", &tree_str, &local],
        )?;
    } else {
        let head = &req.head_ref;
        let remote = format!("origin/{head}");
        fetch_branch(&clone, token, head)?;
        git(
            Some(base),
            origin,
            token,
            &[
                "worktree", "add", "--track", "-B", head, "--", &tree_str, &remote,
            ],
        )?;
    }
    exclude_prdesk(&tree)?;
    Ok(tree_str)
}

/// New branch off the repo's default branch, for work that has no PR yet.
fn prepare_new(req: &BranchRequest, token: &str) -> Result<String, String> {
    if !valid_ref(&req.branch) {
        return Err("Invalid branch name.".into());
    }
    let clone = ensure_clone(
        &req.repo_url,
        &req.owner,
        &req.repo,
        &req.workspace_dir,
        token,
    )?;
    let slug: String = req
        .branch
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let tree = clone.root.join(format!("{}-{slug}", req.repo));
    let tree_str = path_str(&tree)?;
    if tree.exists() {
        return Ok(tree_str);
    }
    let head = local(
        &clone.base,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )?;
    let default = head
        .trim()
        .strip_prefix("origin/")
        .ok_or("Could not find the default branch.")?;
    fetch_branch(&clone, token, default)?;
    let start = format!("origin/{default}");
    git(
        Some(&clone.base),
        &clone.origin,
        token,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            &req.branch,
            "--",
            &tree_str,
            &start,
        ],
    )?;
    exclude_prdesk(&tree)?;
    Ok(tree_str)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrGraphRequest {
    repo_url: String,
    owner: String,
    repo: String,
    number: u32,
    base_ref: String,
    /// Head branches of related PRs in the same repo, drawn alongside.
    #[serde(default)]
    branches: Vec<String>,
    workspace_dir: String,
    limit: u32,
}

/// The PR head lands at origin/pr/<n>, so forks and same-repo PRs look the same in the graph.
fn pr_graph_blocking(req: &PrGraphRequest, token: &str) -> Result<graph::Graph, String> {
    if !valid_ref(&req.base_ref) {
        return Err("Unexpected branch name.".into());
    }
    let clone = ensure_clone(
        &req.repo_url,
        &req.owner,
        &req.repo,
        &req.workspace_dir,
        token,
    )?;
    let related: Vec<&str> = req
        .branches
        .iter()
        .map(String::as_str)
        .filter(|b| valid_ref(b))
        .collect();
    let mut specs = vec![
        format!("+refs/heads/{0}:refs/remotes/origin/{0}", req.base_ref),
        format!("+refs/pull/{0}/head:refs/remotes/origin/pr/{0}", req.number),
    ];
    specs.extend(
        related
            .iter()
            .map(|b| format!("+refs/heads/{b}:refs/remotes/origin/{b}")),
    );
    let mut args = vec!["fetch", "--quiet", "origin"];
    args.extend(specs.iter().map(String::as_str));
    if let Err(e) = git(Some(&clone.base), &clone.origin, token, &args) {
        // Degraded: a related branch may be gone; the base and the PR alone still make a useful graph.
        eprintln!(
            "[workspace.pr_graph] fetch of related branches failed for {}/{}#{}: {e}",
            req.owner, req.repo, req.number
        );
        git(
            Some(&clone.base),
            &clone.origin,
            token,
            &["fetch", "--quiet", "origin", &specs[0], &specs[1]],
        )?;
    }
    let base = format!("refs/remotes/origin/{}", req.base_ref);
    let head = format!("refs/remotes/origin/pr/{}", req.number);
    let others: Vec<String> = related
        .iter()
        .map(|b| format!("refs/remotes/origin/{b}"))
        .filter(|r| local(&clone.base, &["rev-parse", "--verify", "--quiet", r]).is_ok())
        .collect();
    let mut revs = vec![base.as_str(), head.as_str()];
    revs.extend(others.iter().map(String::as_str));
    graph::read_graph(&clone.base, &revs, req.limit)
}

/// Commit graph of a PR against its base, from the workspace clone.
#[tauri::command]
pub async fn pr_graph(
    cache: State<'_, TokenCache>,
    req: PrGraphRequest,
) -> Result<graph::Graph, String> {
    let token = auth::token(&cache)?;
    tauri::async_runtime::spawn_blocking(move || pr_graph_blocking(&req, &token))
        .await
        .map_err(|e| format!("Graph task failed: {e}"))?
}

/// Creates a worktree on a new branch from the default branch and returns its path.
#[tauri::command]
pub async fn prepare_branch(
    cache: State<'_, TokenCache>,
    req: BranchRequest,
) -> Result<String, String> {
    let token = auth::token(&cache)?;
    tauri::async_runtime::spawn_blocking(move || prepare_new(&req, &token))
        .await
        .map_err(|e| format!("Worktree task failed: {e}"))?
}

/// Clones the repo once into the workspace and returns a per-PR worktree path.
#[tauri::command]
pub async fn prepare_worktree(
    cache: State<'_, TokenCache>,
    req: WorktreeRequest,
) -> Result<String, String> {
    let token = auth::token(&cache)?;
    tauri::async_runtime::spawn_blocking(move || prepare(&req, &token))
        .await
        .map_err(|e| format!("Worktree task failed: {e}"))?
}

/// Only paths inside the managed workspace may be read or committed from the UI.
pub(crate) fn inside_workspace(path: &str, workspace_dir: &str) -> Result<PathBuf, String> {
    let root = workspace_root(workspace_dir)?
        .canonicalize()
        .map_err(|e| format!("Workspace folder unavailable: {e}"))?;
    let tree = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("Worktree unavailable: {e}"))?;
    if tree.starts_with(&root) {
        Ok(tree)
    } else {
        Err("That folder is outside the prdesk workspace.".into())
    }
}

// ponytail: diffs past 400 KB are truncated; the agent's real changes are rarely that big.
const MAX_DIFF: usize = 400 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// `git status --porcelain` lines.
    files: Vec<String>,
    diff: String,
    truncated: bool,
    /// Local commits not yet on the upstream; None when the branch has no upstream.
    unpushed: Option<u32>,
}

fn changes(tree: &Path) -> Result<Changes, String> {
    let status = local(tree, &["status", "--porcelain"])?;
    // Intent-to-add makes new files show up in `git diff` without staging their content.
    let _ = local(tree, &["add", "--intent-to-add", "--all"]);
    let mut diff = local(tree, &["diff", "HEAD"])?;
    let truncated = diff.len() > MAX_DIFF;
    if truncated {
        let cut = (0..=MAX_DIFF)
            .rev()
            .find(|i| diff.is_char_boundary(*i))
            .unwrap_or(0);
        diff.truncate(cut);
    }
    let unpushed = local(tree, &["rev-list", "--count", "@{upstream}..HEAD"])
        .ok()
        .and_then(|n| n.trim().parse().ok());
    Ok(Changes {
        files: status.lines().map(str::to_owned).collect(),
        diff,
        truncated,
        unpushed,
    })
}

#[tauri::command]
pub async fn worktree_changes(path: String, workspace_dir: String) -> Result<Changes, String> {
    tauri::async_runtime::spawn_blocking(move || changes(&inside_workspace(&path, &workspace_dir)?))
        .await
        .map_err(|e| format!("Status task failed: {e}"))?
}

const MAX_MESSAGE: usize = 2000;

fn commit_push(tree: &Path, message: &str, origin: &str, token: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() || message.len() > MAX_MESSAGE {
        return Err("The commit message must have between 1 and 2000 characters.".into());
    }
    let dirty = !git(Some(tree), origin, token, &["status", "--porcelain"])?
        .trim()
        .is_empty();
    if dirty {
        git(Some(tree), origin, token, &["add", "--all"])?;
        git(Some(tree), origin, token, &["commit", "-m", message])?;
    }
    // A branch made here has no upstream yet: the first push creates it on origin.
    let tracked = local(tree, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_ok();
    let push: &[&str] = if tracked {
        &["push"]
    } else {
        &["push", "-u", "origin", "HEAD"]
    };
    git(Some(tree), origin, token, push)?;
    Ok(
        git(Some(tree), origin, token, &["rev-parse", "--short", "HEAD"])?
            .trim()
            .to_owned(),
    )
}

/// Commits everything in the worktree (if anything changed) and pushes the PR branch. Returns the short HEAD sha.
#[tauri::command]
pub async fn commit_and_push(
    cache: State<'_, TokenCache>,
    path: String,
    workspace_dir: String,
    message: String,
    repo_url: String,
) -> Result<String, String> {
    let token = auth::token(&cache)?;
    let origin = origin_of(&repo_url)?;
    tauri::async_runtime::spawn_blocking(move || {
        commit_push(
            &inside_workspace(&path, &workspace_dir)?,
            &message,
            &origin,
            &token,
        )
    })
    .await
    .map_err(|e| format!("Push task failed: {e}"))?
}

/// A per-PR worktree found in the workspace (`<owner>/<repo>-pr-<n>`), with what would be lost by removing it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrWorktree {
    owner: String,
    repo: String,
    number: u32,
    path: String,
    /// Uncommitted changes, or the status could not be read.
    dirty: bool,
    /// Commits not on the upstream, or no upstream to compare with (fork PRs): kept to be safe.
    unpushed: bool,
}

/// "api-pr-142" → ("api", 142).
fn parse_pr_dir(name: &str) -> Option<(&str, u32)> {
    let (repo, number) = name.rsplit_once("-pr-")?;
    let number = number.parse().ok()?;
    valid_segment(repo).then_some((repo, number))
}

fn is_dirty(tree: &Path) -> bool {
    local(tree, &["status", "--porcelain"]).map_or(true, |s| !s.trim().is_empty())
}

fn is_unpushed(tree: &Path) -> bool {
    local(tree, &["rev-list", "--count", "@{upstream}..HEAD"])
        .ok()
        .and_then(|n| n.trim().parse::<u32>().ok())
        .is_none_or(|n| n > 0)
}

fn list_pr_worktrees(workspace_dir: &str) -> Result<Vec<PrWorktree>, String> {
    let root = workspace_root(workspace_dir)?;
    let Ok(owners) = std::fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut found = Vec::new();
    for owner_dir in owners.flatten() {
        let owner = owner_dir.file_name().to_string_lossy().into_owned();
        let Ok(entries) = std::fs::read_dir(owner_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some((repo, number)) = parse_pr_dir(&name) else {
                continue;
            };
            let tree = entry.path();
            // A worktree has a `.git` file pointing at the shared clone; anything else is not ours to touch.
            if !tree.join(".git").is_file() || !valid_segment(&owner) {
                continue;
            }
            found.push(PrWorktree {
                owner: owner.clone(),
                repo: repo.to_owned(),
                number,
                path: path_str(&tree)?,
                dirty: is_dirty(&tree),
                unpushed: is_unpushed(&tree),
            });
        }
    }
    Ok(found)
}

/// Per-PR worktrees in the workspace, for cleaning up the ones whose PR is closed.
#[tauri::command]
pub async fn pr_worktrees(workspace_dir: String) -> Result<Vec<PrWorktree>, String> {
    tauri::async_runtime::spawn_blocking(move || list_pr_worktrees(&workspace_dir))
        .await
        .map_err(|e| format!("Worktree scan failed: {e}"))?
}

fn remove_tree(tree: &Path) -> Result<(), String> {
    // Checked again here: the UI's scan may be stale, and nothing unsaved may be lost.
    if is_dirty(tree) || is_unpushed(tree) {
        return Err("This worktree has local changes or unpushed commits; it was kept.".into());
    }
    let common = local(tree, &["rev-parse", "--git-common-dir"])?;
    let common = tree.join(common.trim());
    let clone = common
        .parent()
        .ok_or("Could not find the repository clone.")?;
    // No --force: git itself refuses to drop a worktree with changes.
    local(clone, &["worktree", "remove", "--", &path_str(tree)?]).map(|_| ())
}

/// Removes a clean, fully pushed per-PR worktree. The shared clone and the branch stay.
#[tauri::command]
pub async fn remove_worktree(path: String, workspace_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_tree(&inside_workspace(&path, &workspace_dir)?)
    })
    .await
    .map_err(|e| format!("Worktree removal failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_names() {
        assert!(valid_segment("my-repo.rs"));
        assert!(!valid_segment(".."));
        assert!(!valid_segment("a/b"));
        assert!(valid_ref("feature/login-fix"));
        assert!(!valid_ref("--upload-pack=evil"));
        assert!(!valid_ref("a..b"));
        assert!(!valid_ref("a b"));
    }

    #[test]
    fn reads_pr_worktree_names() {
        assert_eq!(parse_pr_dir("api-pr-142"), Some(("api", 142)));
        assert_eq!(parse_pr_dir("my-pr-tool-pr-7"), Some(("my-pr-tool", 7)));
        assert_eq!(parse_pr_dir("api-add-retry"), None);
        assert_eq!(parse_pr_dir("api-pr-x"), None);
        assert_eq!(parse_pr_dir("..-pr-1"), None);
    }

    #[test]
    fn origin_keeps_only_the_host() {
        assert_eq!(
            origin_of("https://github.com/acme/api").unwrap(),
            "https://github.com/"
        );
        assert!(origin_of("http://github.com/acme/api").is_err());
    }
}
