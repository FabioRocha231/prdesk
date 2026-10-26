mod agent;
mod auth;
mod github;
mod graph;
mod pty;
mod workspace;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

/// Brings prdesk to the front from anywhere.
const SUMMON_SHORTCUT: &str = "CommandOrControl+Shift+P";

fn summon(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(SUMMON_SHORTCUT)
                .expect("static shortcut is valid")
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        summon(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(auth::TokenCache::default())
        .manage(pty::Sessions::default())
        .invoke_handler(tauri::generate_handler![
            auth::token_status,
            auth::save_token,
            auth::clear_token,
            github::github_graphql,
            graph::git_graph,
            graph::git_repos,
            graph::git_fetch,
            workspace::pr_graph,
            github::rerun_failed_jobs,
            github::save_ci_log,
            github::github_notifications,
            github::github_rest,
            agent::agent_run,
            agent::write_agent_context,
            workspace::prepare_branch,
            workspace::worktree_changes,
            workspace::commit_and_push,
            workspace::prepare_worktree,
            pty::pty_spawn,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
