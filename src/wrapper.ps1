# >>> claude-auto-retry >>>
# Claude Code's own installer may leave a `claude` alias behind; an alias shadows a
# function of the same name, so drop it before defining ours.
if (Test-Path Alias:claude) { Remove-Item Alias:claude -Force -ErrorAction SilentlyContinue }
function claude {
    $launcher = '__LAUNCHER_PATH__'
    $real = (Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)

    # Degrade to plain claude if already inside a wrapped session, or if the launcher is
    # gone (package removed via `npm uninstall -g` without `claude-auto-retry uninstall`
    # first) — an orphaned wrapper must never break the claude command.
    if ($env:CLAUDE_AUTO_RETRY_ACTIVE -eq '1' -or -not (Test-Path -LiteralPath $launcher)) {
        if ($null -eq $real) { Write-Error 'claude.exe not found on PATH'; return }
        & $real.Source @args
        return
    }

    $env:CLAUDE_AUTO_RETRY_ACTIVE = '1'
    try {
        & node $launcher @args
    } finally {
        # Runs on Ctrl-C as well, so the variable never outlives the session and turn the
        # next launch into a silent degrade.
        Remove-Item Env:\CLAUDE_AUTO_RETRY_ACTIVE -ErrorAction SilentlyContinue
    }
}
# <<< claude-auto-retry <<<
