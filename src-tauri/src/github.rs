use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::State;

use crate::auth::{self, TokenCache};

const TIMEOUT: Duration = Duration::from_secs(30);

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent("prdesk")
        .build()
        .expect("static reqwest client config is valid")
});

const MAX_ATTEMPTS: u32 = 3;

/// Exponential backoff (1s, 2s) plus up to 250ms of jitter taken from the clock.
fn backoff(attempt: u32) -> Duration {
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_millis() % 250));
    Duration::from_millis(1000 * 2u64.pow(attempt - 1) + jitter)
}

/// Runs a GraphQL query against GitHub. The token never leaves the Rust side.
#[tauri::command]
pub async fn github_graphql(
    cache: State<'_, TokenCache>,
    api_url: String,
    query: String,
    variables: Value,
) -> Result<Value, String> {
    if !api_url.starts_with("https://") {
        return Err("The GitHub API URL must use https.".into());
    }
    let token = auth::token(&cache)?;
    let payload = json!({ "query": query, "variables": variables });

    let mut attempt = 1;
    let res = loop {
        let res = CLIENT
            .post(&api_url)
            .bearer_auth(&token)
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                eprintln!("[github.github_graphql] request failed: {e}");
                if e.is_timeout() {
                    "GitHub did not answer in 30s.".to_owned()
                } else {
                    "Could not reach GitHub.".to_owned()
                }
            })?;
        // Heavy search queries hit sporadic 502/503/504 from GitHub; those clear up on retry.
        let transient = matches!(res.status().as_u16(), 502..=504);
        if !transient || attempt == MAX_ATTEMPTS {
            break res;
        }
        let delay = backoff(attempt);
        eprintln!(
            "[github.github_graphql] attempt {attempt} got {}, retrying in {delay:?}",
            res.status()
        );
        tokio::time::sleep(delay).await;
        attempt += 1;
    };

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("GitHub rejected the token (401). Update it in Settings.".into());
    }
    let body: Value = res.json().await.map_err(|e| {
        eprintln!("[github.github_graphql] invalid JSON (status {status}): {e}");
        format!("GitHub answered {status} with an unreadable body.")
    })?;
    if !status.is_success() {
        let message = body["message"].as_str().unwrap_or("request failed");
        return Err(format!("GitHub answered {status}: {message}"));
    }
    if let Some(errors) = body["errors"].as_array().filter(|e| !e.is_empty()) {
        let messages: Vec<&str> = errors
            .iter()
            .filter_map(|e| e["message"].as_str())
            .collect();
        return Err(format!("GitHub GraphQL error: {}", messages.join("; ")));
    }
    Ok(body["data"].clone())
}

/// REST base for a GraphQL endpoint: api.github.com/graphql → api.github.com, GHE host/api/graphql → host/api/v3.
fn rest_base(api_url: &str) -> Result<String, String> {
    let base = api_url
        .strip_suffix("/graphql")
        .ok_or("The GitHub API URL must end with /graphql.")?;
    Ok(if base.ends_with("/api") {
        format!("{base}/v3")
    } else {
        base.to_owned()
    })
}

fn valid_rest_path(path: &str) -> bool {
    path.starts_with("/repos/")
        && !path.contains("..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_.-?=&".contains(c))
}

async fn rest(
    token: &str,
    api_url: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<String, String> {
    if !api_url.starts_with("https://") || !valid_rest_path(path) {
        return Err("Unexpected GitHub REST request.".into());
    }
    let url = format!("{}{path}", rest_base(api_url)?);
    // Log downloads redirect to a pre-signed URL; reqwest drops the auth header on that cross-host hop.
    let mut req = CLIENT
        .request(method, &url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json");
    if let Some(json) = body {
        req = req.json(json);
    }
    let res = req.send().await.map_err(|e| {
        eprintln!("[github.rest] {path} failed: {e}");
        "Could not reach GitHub.".to_owned()
    })?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("Unreadable GitHub answer: {e}"))?;
    if status.is_success() {
        return Ok(text);
    }
    eprintln!("[github.rest] {path} answered {status}: {text}");
    // GitHub's own message (e.g. "line must be part of the diff") tells the user what to fix.
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let detail = parsed["errors"][0]["message"]
        .as_str()
        .or(parsed["errors"][0].as_str())
        .or(parsed["message"].as_str())
        .unwrap_or("request failed");
    Err(format!("GitHub answered {status}: {detail}"))
}

const REST_METHODS: [&str; 4] = ["GET", "POST", "PATCH", "PUT"];

/// REST call under /repos/ for writes GraphQL lacks (reviews with line comments, update-branch, create PR).
/// Returns the parsed JSON, or null for empty answers.
#[tauri::command]
pub async fn github_rest(
    cache: State<'_, TokenCache>,
    api_url: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !REST_METHODS.contains(&method.as_str()) {
        return Err("Unsupported REST method.".into());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let token = auth::token(&cache)?;
    let text = rest(&token, &api_url, method, &path, body.as_ref()).await?;
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("Unreadable GitHub answer: {e}"))
}

/// Re-runs only the failed jobs of a GitHub Actions workflow run.
#[tauri::command]
pub async fn rerun_failed_jobs(
    cache: State<'_, TokenCache>,
    api_url: String,
    owner: String,
    repo: String,
    run_id: u64,
) -> Result<(), String> {
    let token = auth::token(&cache)?;
    let path = format!("/repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs");
    rest(&token, &api_url, reqwest::Method::POST, &path, None)
        .await
        .map(|_| ())
}

// ponytail: keeps the last 400 lines of a job log, where the failure almost always is.
const LOG_TAIL_LINES: usize = 400;

async fn log_tail(
    token: &str,
    api_url: &str,
    owner: &str,
    repo: &str,
    job_id: u64,
) -> Result<String, String> {
    let path = format!("/repos/{owner}/{repo}/actions/jobs/{job_id}/logs");
    let log = rest(token, api_url, reqwest::Method::GET, &path, None).await?;
    let lines: Vec<&str> = log.lines().collect();
    Ok(lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].join("\n"))
}

/// A failed job's log tail, to read it in the app.
#[tauri::command]
pub async fn ci_log(
    cache: State<'_, TokenCache>,
    api_url: String,
    owner: String,
    repo: String,
    job_id: u64,
) -> Result<String, String> {
    let token = auth::token(&cache)?;
    log_tail(&token, &api_url, &owner, &repo, job_id).await
}

/// Downloads a failed job's log tail into the workspace and returns the file path for the agent to read.
#[tauri::command]
pub async fn save_ci_log(
    cache: State<'_, TokenCache>,
    api_url: String,
    owner: String,
    repo: String,
    job_id: u64,
    workspace_dir: String,
) -> Result<String, String> {
    let token = auth::token(&cache)?;
    let tail = log_tail(&token, &api_url, &owner, &repo, job_id).await?;

    let dir = crate::workspace::workspace_root(&workspace_dir)?.join(".ci-logs");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let file = dir.join(format!("{owner}-{repo}-{job_id}.log"));
    std::fs::write(&file, tail).map_err(|e| format!("Could not write the log: {e}"))?;
    file.to_str()
        .map(str::to_owned)
        .ok_or("Log path is not valid UTF-8.".into())
}

// Each new notification costs one extra request for its actor and text; beyond this the UI only summarizes.
const MAX_ENRICHED: usize = 10;
const MAX_BODY: usize = 2000;
const DEFAULT_POLL_SECONDS: u64 = 60;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    id: String,
    reason: String,
    repo: String,
    number: Option<u64>,
    title: String,
    updated_at: String,
    actor: Option<String>,
    body: Option<String>,
    /// Database id of the comment or review the notification points at, so the app can scroll to it.
    comment_id: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inbox {
    items: Vec<Activity>,
    last_modified: Option<String>,
    poll_seconds: u64,
}

/// Author and markdown of the comment (or PR) a notification points at.
async fn latest_comment(token: &str, api_url: &str, url: &str) -> Option<(String, String)> {
    let path = url.strip_prefix(&rest_base(api_url).ok()?)?;
    let body: Value = serde_json::from_str(
        &rest(token, api_url, reqwest::Method::GET, path, None)
            .await
            .ok()?,
    )
    .ok()?;
    let actor = body["user"]["login"].as_str()?.to_owned();
    let text: String = body["body"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(MAX_BODY)
        .collect();
    Some((actor, text))
}

/// The trailing number of a comment or review API URL (`…/issues/comments/123`, `…/pulls/1/reviews/9`).
fn comment_id(url: &str) -> Option<u64> {
    url.rsplit('/').next()?.parse().ok()
}

/// New pull-request notifications (the same feed GitHub Mobile pushes) updated after `since`.
/// `last_modified` makes an unchanged poll a free 304; `poll_seconds` is GitHub's requested interval.
#[tauri::command]
pub async fn github_notifications(
    cache: State<'_, TokenCache>,
    api_url: String,
    since: String,
    last_modified: Option<String>,
) -> Result<Inbox, String> {
    if !api_url.starts_with("https://") {
        return Err("The GitHub API URL must use https.".into());
    }
    // An ISO-8601 timestamp needs no URL encoding; anything else is rejected.
    if since.is_empty()
        || !since
            .chars()
            .all(|c| c.is_ascii_digit() || "-:.TZ".contains(c))
    {
        return Err("Invalid notifications timestamp.".into());
    }
    let token = auth::token(&cache)?;
    let url = format!(
        "{}/notifications?participating=true&per_page=50&since={since}",
        rest_base(&api_url)?
    );
    let mut req = CLIENT
        .get(url)
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json");
    if let Some(lm) = &last_modified {
        req = req.header("If-Modified-Since", lm);
    }
    let res = req.send().await.map_err(|e| {
        eprintln!("[github.github_notifications] request failed: {e}");
        "Could not reach GitHub.".to_owned()
    })?;

    let header = |name: &str| {
        res.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let poll_seconds = header("X-Poll-Interval")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_POLL_SECONDS);
    let status = res.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(Inbox {
            items: vec![],
            last_modified,
            poll_seconds,
        });
    }
    let new_last_modified = header("Last-Modified").or(last_modified);
    let body = res
        .text()
        .await
        .map_err(|e| format!("Unreadable GitHub answer: {e}"))?;
    if !status.is_success() {
        eprintln!("[github.github_notifications] answered {status}: {body}");
        return Err(format!("GitHub answered {status} for notifications."));
    }
    let threads: Vec<Value> =
        serde_json::from_str(&body).map_err(|e| format!("Unreadable notifications: {e}"))?;

    let mut items = Vec::new();
    for t in threads
        .iter()
        .filter(|t| t["subject"]["type"] == "PullRequest")
    {
        let subject = &t["subject"];
        let reason = t["reason"].as_str().unwrap_or_default();
        // A real comment names who acted. When GitHub points at the PR itself, its author is only the actor
        // for requests and assignments (otherwise "author" would be me on my own PRs).
        let comment = subject["latest_comment_url"]
            .as_str()
            .filter(|u| Some(*u) != subject["url"].as_str());
        let pointer = comment.or_else(|| {
            matches!(reason, "review_requested" | "assign")
                .then(|| subject["url"].as_str())
                .flatten()
        });
        let enriched = match pointer {
            Some(url) if items.len() < MAX_ENRICHED => latest_comment(&token, &api_url, url).await,
            _ => None,
        };
        let (actor, text) = enriched.unzip();
        items.push(Activity {
            id: t["id"].as_str().unwrap_or_default().to_owned(),
            reason: reason.to_owned(),
            repo: t["repository"]["full_name"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            number: subject["url"]
                .as_str()
                .and_then(|u| u.rsplit('/').next())
                .and_then(|n| n.parse().ok()),
            title: subject["title"].as_str().unwrap_or_default().to_owned(),
            updated_at: t["updated_at"].as_str().unwrap_or_default().to_owned(),
            actor,
            body: text,
            comment_id: comment.and_then(comment_id),
        });
    }
    Ok(Inbox {
        items,
        last_modified: new_last_modified,
        poll_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_graphql_to_rest() {
        assert_eq!(
            rest_base("https://api.github.com/graphql").unwrap(),
            "https://api.github.com"
        );
        assert_eq!(
            rest_base("https://ghe.acme.io/api/graphql").unwrap(),
            "https://ghe.acme.io/api/v3"
        );
        assert!(valid_rest_path("/repos/acme/api/actions/jobs/12/logs"));
        assert!(!valid_rest_path("/repos/../user"));
        assert!(!valid_rest_path("/user"));
    }

    #[test]
    fn reads_the_comment_id_from_its_url() {
        assert_eq!(
            comment_id("https://api.github.com/repos/acme/api/issues/comments/123"),
            Some(123)
        );
        assert_eq!(
            comment_id("https://api.github.com/repos/acme/api/pulls/comments/"),
            None
        );
    }
}
