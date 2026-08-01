use std::{path::PathBuf, time::Duration};

use anyhow::{Context, Result};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub async fn supervise_cloudflared(token_file: PathBuf, shutdown: CancellationToken) -> Result<()> {
    let mut failures = 0_u32;
    loop {
        let mut child = Command::new("cloudflared")
            .args(["tunnel", "--no-autoupdate", "run", "--token-file"])
            .arg(&token_file)
            .kill_on_drop(true)
            .spawn()
            .context("start cloudflared")?;
        tokio::select! {
            result = child.wait() => {
                tracing::warn!(status=?result?, "cloudflared exited; restarting");
            }
            _ = shutdown.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Ok(());
            }
        }
        failures = failures.saturating_add(1);
        let delay = Duration::from_secs(2_u64.saturating_pow(failures.min(5)));
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = tokio::time::sleep(delay) => {}
        }
    }
}
