# CI failure reporter (build jobs):
#  1. collects the job's build log (default apps/desktop/tauri-build.log, override -LogPath)
#     -> ci-failure.txt (+ token permissions)
#  2. channel A: GitHub issue with the full log (gh CLI, curl fallback)
#  3. channel B: force-push of the log to the arena/ci-logs branch
# Every native command's exit code is printed; nothing here may silently die.
param([string]$LogPath = 'apps/desktop/tauri-build.log')
$ErrorActionPreference = 'Continue'

if (Test-Path $LogPath) {
    Copy-Item $LogPath 'ci-failure.txt' -Force
    "log copied: $LogPath"
} else {
    Set-Content -Path 'ci-failure.txt' -Value "build log not found: $LogPath" -Encoding utf8
    "WARNING: $LogPath missing"
}

$perm = gh api "repos/$env:GITHUB_REPOSITORY" --jq '.permissions' 2>&1
"permissions (exit $LASTEXITCODE): $perm"
Add-Content 'ci-failure.txt' "=== GITHUB_TOKEN permissions: $perm"

git config user.email 'github-actions@github.com'
git config user.name 'github-actions[bot]'

'=== ISSUE channel ==='
$ghIssue = gh issue create --title 'CI: Windows build failure log' --body-file ci-failure.txt 2>&1
"gh issue create (exit $LASTEXITCODE): $ghIssue"
if ($LASTEXITCODE -ne 0) {
    'trying curl fallback'
    $logText = Get-Content 'ci-failure.txt' -Raw
    $payload = @{ title = 'CI: Windows build failure log'; body = $logText } | ConvertTo-Json -Depth 5
    $curlOut = curl.exe -s -X POST -H "Authorization: token $($env:GITHUB_TOKEN)" -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' -d $payload "https://api.github.com/repos/$env:GITHUB_REPOSITORY/issues" 2>&1
    "curl issue create (exit $LASTEXITCODE): $curlOut"
}

'=== BRANCH channel ==='
git add -f ci-failure.txt
"git add exit=$LASTEXITCODE"
$commitOut = git commit -m 'ci: windows build failure log' 2>&1
"git commit exit=$LASTEXITCODE: $commitOut"
$pushOut = git push -f origin HEAD:arena/ci-logs 2>&1
"git push exit=$LASTEXITCODE: $pushOut"
'=== REPORT DONE ==='
