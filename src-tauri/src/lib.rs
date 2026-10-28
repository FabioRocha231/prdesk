mod agent;
mod auth;
mod github;
mod graph;
mod mission;
mod pty;
mod workspace;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
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

/// A child process that opens no console window on Windows. A GUI app's console children each get a window of
/// their own otherwise, so every git or gh call would flash one.
pub(crate) fn command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

const TRAY_ID: &str = "main";

/// Tray icon: click (or "Abrir") brings the window back; the title and tooltip carry the my-turn count.
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir prdesk", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("prdesk")
        .menu(&Menu::with_items(app, &[&open, &quit])?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => summon(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                summon(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Scales the whole interface, for big monitors. A command of ours: the webview's own zoom permission was refused.
#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, zoom: f64) -> Result<(), String> {
    window.set_zoom(zoom).map_err(|e| e.to_string())
}

/// Shows how many PRs are my turn next to the tray icon (title on macOS/Linux, tooltip everywhere).
#[tauri::command]
fn set_tray_count(app: AppHandle, count: u32) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let label = (count > 0).then(|| count.to_string());
    // Degraded: Windows has no tray title; the tooltip still says it.
    let _ = tray.set_title(label.as_deref());
    let tooltip = match count {
        0 => "prdesk: nada esperando você".to_owned(),
        1 => "prdesk: 1 PR esperando você".to_owned(),
        n => format!("prdesk: {n} PRs esperando você"),
    };
    let _ = tray.set_tooltip(Some(tooltip));
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| Ok(tray(app.handle())?))
        .manage(auth::TokenCache::default())
        .manage(pty::Sessions::default())
        .invoke_handler(tauri::generate_handler![
            set_tray_count,
            set_zoom,
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
            mission::mission_list,
            mission::mission_read,
            mission::mission_write,
            mission::mission_plan_path,
            mission::mission_agent,
            agent::read_agent_notes,
            workspace::prepare_branch,
            workspace::worktree_changes,
            workspace::commit_and_push,
            workspace::prepare_worktree,
            workspace::pr_worktrees,
            workspace::remove_worktree,
            pty::pty_spawn,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
