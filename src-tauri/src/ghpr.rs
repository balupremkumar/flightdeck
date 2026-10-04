// ghpr.rs — H6: the PR for a workspace's current branch and its CI roll-up, via
// the `gh` CLI. No gh, no PR, no auth, a timeout: all yield None, never an error.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub url: String,
    /// OPEN | MERGED | CLOSED (as gh reports it).
    pub state: String,
    /// none | running | passed | failed
    pub checks: String,
}

fn rollup(items: &[Value]) -> &'static str {
    if items.is_empty() {
        return "none";
    }
    let (mut pending, mut failed) = (false, false);
    for it in items {
        let s = |k: &str| it.get(k).and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
        // CheckRun: status + conclusion. StatusContext: state.
        let (status, conclusion, state) = (s("status"), s("conclusion"), s("state"));
        if !status.is_empty() && status != "COMPLETED" {
            pending = true;
        } else if matches!(conclusion.as_str(), "FAILURE" | "TIMED_OUT" | "CANCELLED" | "STARTUP_FAILURE" | "ACTION_REQUIRED")
            || matches!(state.as_str(), "FAILURE" | "ERROR")
        {
            failed = true;
        } else if matches!(state.as_str(), "PENDING" | "EXPECTED") {
            pending = true;
        }
    }
    if pending { "running" } else if failed { "failed" } else { "passed" }
}

/// Parse `gh pr view --json number,url,state,statusCheckRollup`. Missing fields degrade.
pub fn parse_pr(text: &str) -> Option<PrInfo> {
    let v: Value = serde_json::from_str(text).ok()?;
    let number = v.get("number")?.as_u64()?;
    let url = v.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    let state = v.get("state").and_then(Value::as_str).unwrap_or("OPEN").to_string();
    let checks = v
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .map(|a| rollup(a))
        .unwrap_or("none")
        .to_string();
    Some(PrInfo { number, url, state, checks })
}

#[tauri::command(async)]
pub fn pr_status(cwd: String) -> Option<PrInfo> {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["pr", "view", "--json", "number,url,state,statusCheckRollup"])
        .current_dir(&cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1");
    parse_pr(&crate::ports::run_bounded(cmd, Duration::from_secs(10))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_passed_failed_rollups() {
        let run = r#"{"number":12,"url":"u","state":"OPEN","statusCheckRollup":[
            {"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"IN_PROGRESS","conclusion":""}]}"#;
        assert_eq!(parse_pr(run).unwrap().checks, "running");
        let ok = r#"{"number":12,"url":"u","state":"OPEN","statusCheckRollup":[
            {"status":"COMPLETED","conclusion":"SUCCESS"},{"state":"SUCCESS"},{"status":"COMPLETED","conclusion":"SKIPPED"}]}"#;
        assert_eq!(parse_pr(ok).unwrap().checks, "passed");
        let bad = r#"{"number":12,"url":"u","state":"OPEN","statusCheckRollup":[
            {"status":"COMPLETED","conclusion":"FAILURE"},{"state":"SUCCESS"}]}"#;
        assert_eq!(parse_pr(bad).unwrap().checks, "failed");
        let ctx = r#"{"number":1,"url":"u","state":"OPEN","statusCheckRollup":[{"state":"PENDING"}]}"#;
        assert_eq!(parse_pr(ctx).unwrap().checks, "running");
    }

    #[test]
    fn missing_fields_and_garbage_degrade() {
        let p = parse_pr(r#"{"number":5}"#).unwrap();
        assert_eq!((p.checks.as_str(), p.state.as_str(), p.url.as_str()), ("none", "OPEN", ""));
        assert_eq!(parse_pr(r#"{"number":5,"statusCheckRollup":null}"#).unwrap().checks, "none");
        assert!(parse_pr(r#"{"url":"u"}"#).is_none());
        assert!(parse_pr("not json").is_none());
        assert!(parse_pr("").is_none());
    }
}
