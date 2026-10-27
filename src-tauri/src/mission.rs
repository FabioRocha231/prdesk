//! A mission's files: `<workspace>/missions/<id>/{plan.md,mission.json}`, plus the planning agent run.
//! Nothing here reads or writes outside that folder; the planning agent runs at the workspace root so it can read
//! every part's worktree.

use std::path::PathBuf;

use crate::agent::run_headless;
use crate::workspace::workspace_root;

const MISSIONS_DIR: &str = "missions";
const FILES: [&str; 4] = ["plan.md", "mission.json", "request.md", "check.md"];
/// What a mission agent run may be handed: the planning request or the integration check.
const AGENT_INPUTS: [&str; 2] = ["request.md", "check.md"];
const MAX_FILE: usize = 1024 * 1024;
const MAX_ID: usize = 80;

/// Ids are slugs the app generates ("2026-10-27-order-number"); anything else could escape the folder.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn mission_dir(workspace_dir: &str, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid mission id.".into());
    }
    Ok(workspace_root(workspace_dir)?.join(MISSIONS_DIR).join(id))
}

fn mission_file(workspace_dir: &str, id: &str, file: &str) -> Result<PathBuf, String> {
    if !FILES.contains(&file) {
        return Err("Unexpected mission file.".into());
    }
    Ok(mission_dir(workspace_dir, id)?.join(file))
}

fn write_file(path: &PathBuf, text: &str) -> Result<(), String> {
    if text.len() > MAX_FILE {
        return Err("The mission file is too large.".into());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create the mission folder: {e}"))?;
    }
    std::fs::write(path, text).map_err(|e| format!("Could not save the mission file: {e}"))
}

/// Every mission's `mission.json`, as text; folders without one (or unreadable) are skipped.
#[tauri::command]
pub fn mission_list(workspace_dir: String) -> Result<Vec<String>, String> {
    let root = workspace_root(&workspace_dir)?.join(MISSIONS_DIR);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(vec![]);
    };
    Ok(entries
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path().join("mission.json")).ok())
        .collect())
}

/// A mission file's text; empty when it does not exist yet.
#[tauri::command]
pub fn mission_read(workspace_dir: String, id: String, file: String) -> Result<String, String> {
    let path = mission_file(&workspace_dir, &id, &file)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Could not read the mission file: {e}")),
    }
}

#[tauri::command]
pub fn mission_write(
    workspace_dir: String,
    id: String,
    file: String,
    text: String,
) -> Result<(), String> {
    write_file(&mission_file(&workspace_dir, &id, &file)?, &text)
}

/// Where a mission's plan lives, for "show in Finder".
#[tauri::command]
pub fn mission_plan_path(workspace_dir: String, id: String) -> Result<String, String> {
    mission_file(&workspace_dir, &id, "plan.md")?
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "The mission path is not valid UTF-8.".into())
}

/// Saves `text` as the mission's `file` (request.md for planning, check.md for the integration check) and runs the
/// agent at the workspace root, where every part's worktree is visible; returns what the agent printed.
#[tauri::command]
pub async fn mission_agent(
    workspace_dir: String,
    id: String,
    command: String,
    file: String,
    text: String,
) -> Result<String, String> {
    if !AGENT_INPUTS.contains(&file.as_str()) {
        return Err("Unexpected mission agent input.".into());
    }
    write_file(&mission_file(&workspace_dir, &id, &file)?, &text)?;
    let root = workspace_root(&workspace_dir)?;
    run_headless(&root, &command).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_plain_slugs() {
        assert!(valid_id("2026-10-27-order-number"));
        assert!(!valid_id(""));
        assert!(!valid_id("../etc"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("-x"));
        assert!(!valid_id("Upper"));
        assert!(!valid_id(&"a".repeat(MAX_ID + 1)));
    }

    #[test]
    fn only_known_files_resolve() {
        let dir = std::env::temp_dir().join("prdesk-mission-test");
        let ws = dir.to_str().unwrap();
        assert!(
            mission_file(ws, "m", "plan.md")
                .unwrap()
                .ends_with("missions/m/plan.md")
        );
        assert!(mission_file(ws, "m", "../../x").is_err());
        assert!(mission_file(ws, "m", "notes.md").is_err());
    }

    #[test]
    fn write_then_read_and_list() {
        let dir = std::env::temp_dir().join(format!("prdesk-mission-{}", std::process::id()));
        let ws = dir.to_str().unwrap().to_owned();
        assert_eq!(
            mission_read(ws.clone(), "m".into(), "plan.md".into()).unwrap(),
            ""
        );
        mission_write(ws.clone(), "m".into(), "plan.md".into(), "# Plan".into()).unwrap();
        mission_write(ws.clone(), "m".into(), "mission.json".into(), "{}".into()).unwrap();
        assert_eq!(
            mission_read(ws.clone(), "m".into(), "plan.md".into()).unwrap(),
            "# Plan"
        );
        assert_eq!(mission_list(ws).unwrap(), vec!["{}".to_owned()]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
