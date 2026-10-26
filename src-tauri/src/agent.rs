use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::workspace::{exclude_prdesk, inside_workspace};

// Long reviews on big PRs take minutes; past this the run is killed.
const TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_CONTEXT: usize = 2 * 1024 * 1024;
const MAX_OUTPUT: usize = 512 * 1024;
const ERROR_TAIL: usize = 600;
const CONTEXT_FILE: &str = ".prdesk/context.md";

/// The user's shell, as a login + interactive shell so PATH and aliases match their terminal.
fn shell(command: &str) -> Command {
    if cfg!(windows) {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoLogo", "-Command", command]);
        cmd
    } else {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = Command::new(sh);
        cmd.args(["-l", "-i", "-c", command]);
        cmd
    }
}

fn tail(text: &str) -> &str {
    let start = text.len().saturating_sub(ERROR_TAIL);
    let start = (start..text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    text[start..].trim()
}

fn write_context(tree: &std::path::Path, text: &str) -> Result<(), String> {
    if text.len() > MAX_CONTEXT {
        return Err("The context for the agent is too large.".into());
    }
    exclude_prdesk(tree)?;
    std::fs::create_dir_all(tree.join(".prdesk"))
        .map_err(|e| format!("Could not write agent context: {e}"))?;
    std::fs::write(tree.join(CONTEXT_FILE), text)
        .map_err(|e| format!("Could not write agent context: {e}"))
}

/// Writes `.prdesk/context.md` for an interactive agent whose prompt points at it.
#[tauri::command]
pub fn write_agent_context(
    path: String,
    workspace_dir: String,
    text: String,
) -> Result<(), String> {
    write_context(&inside_workspace(&path, &workspace_dir)?, &text)
}

/// Runs an agent CLI headless (`claude -p`, `codex exec`, …) in a worktree and returns what it printed.
/// `context` (diff, threads) is written to `.prdesk/context.md` for the agent to read, keeping argv short.
#[tauri::command]
pub async fn agent_run(
    path: String,
    workspace_dir: String,
    command: String,
    context: Option<String>,
) -> Result<String, String> {
    let tree = inside_workspace(&path, &workspace_dir)?;
    if let Some(text) = context {
        write_context(&tree, &text)?;
    }

    let child = shell(&command)
        .current_dir(&tree)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start the agent: {e}"))?;
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "The agent took more than 10 minutes and was stopped.".to_owned())?
        .map_err(|e| format!("The agent failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        eprintln!("[agent.agent_run] exit {:?}: {stderr}", out.status.code());
        let reason = if stderr.trim().is_empty() {
            tail(&stdout)
        } else {
            tail(&stderr)
        };
        return Err(format!("The agent exited with an error: {reason}"));
    }
    Ok(stdout.chars().take(MAX_OUTPUT).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_end_on_char_boundaries() {
        let text = format!("{}ção", "a".repeat(ERROR_TAIL));
        assert!(tail(&text).ends_with("ção"));
        assert!(tail(&text).len() <= ERROR_TAIL + 1);
    }
}
