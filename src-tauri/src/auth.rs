use std::sync::Mutex;

use keyring::Entry;
use serde::Serialize;
use tauri::State;

const SERVICE: &str = "dev.prdesk.app";
const ACCOUNT: &str = "github";

// GUI apps on macOS start with a minimal PATH, so `gh` is also looked up in the usual install dirs.
const GH_CANDIDATES: [&str; 4] = [
    "gh",
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
];

/// Token resolved once and reused until the user saves or clears one.
#[derive(Default)]
pub struct TokenCache(Mutex<Option<String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    /// "keychain", "gh", or None when no token is available.
    source: Option<&'static str>,
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Keychain unavailable: {e}"))
}

fn keychain_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain read failed: {e}")),
    }
}

fn gh_token() -> Option<String> {
    GH_CANDIDATES.iter().find_map(|bin| {
        let out = crate::command(bin).args(["auth", "token"]).output().ok()?;
        let token = String::from_utf8(out.stdout).ok()?.trim().to_owned();
        (out.status.success() && !token.is_empty()).then_some(token)
    })
}

fn resolve() -> Result<Option<(String, &'static str)>, String> {
    if let Some(token) = keychain_token()? {
        return Ok(Some((token, "keychain")));
    }
    Ok(gh_token().map(|token| (token, "gh")))
}

/// Returns the cached token, resolving it from the keychain or `gh` on first use.
pub fn token(cache: &TokenCache) -> Result<String, String> {
    let mut cached = cache
        .0
        .lock()
        .map_err(|_| "Token cache poisoned".to_owned())?;
    if let Some(token) = cached.as_ref() {
        return Ok(token.clone());
    }
    let (token, _) =
        resolve()?.ok_or("No GitHub token. Add one in Settings or run `gh auth login`.")?;
    *cached = Some(token.clone());
    Ok(token)
}

#[tauri::command]
pub fn token_status() -> Result<TokenStatus, String> {
    Ok(TokenStatus {
        source: resolve()?.map(|(_, source)| source),
    })
}

#[tauri::command]
pub fn save_token(cache: State<'_, TokenCache>, token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() || token.len() > 512 {
        return Err("Token must be between 1 and 512 characters.".into());
    }
    entry()?
        .set_password(token)
        .map_err(|e| format!("Keychain write failed: {e}"))?;
    *cache
        .0
        .lock()
        .map_err(|_| "Token cache poisoned".to_owned())? = Some(token.to_owned());
    Ok(())
}

#[tauri::command]
pub fn clear_token(cache: State<'_, TokenCache>) -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("Keychain delete failed: {e}")),
    }
    *cache
        .0
        .lock()
        .map_err(|_| "Token cache poisoned".to_owned())? = None;
    Ok(())
}
