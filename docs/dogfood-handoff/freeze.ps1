# DOGFOOD freeze, in one command, on the machine that has the repo.
#
#   cd D:\project\dogfood-2026
#   powershell -ExecutionPolicy Bypass -File <path>\freeze.ps1
#
# It never deletes or resets anything. It runs the checks, saves their output
# under freeze-evidence\, adds the container-proof workflow, commits, tags and
# pushes (if a remote exists). It stops at the first failing check.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = "freeze-evidence"
New-Item -ItemType Directory -Force $out | Out-Null

function Step($name, [scriptblock]$cmd) {
  Write-Host "`n== $name" -ForegroundColor Cyan
  $log = Join-Path $out (($name -replace '[^a-zA-Z0-9]+', '-').ToLower() + ".log")
  & $cmd 2>&1 | Tee-Object -FilePath $log
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $name (see $log). Nothing was committed." -ForegroundColor Red; exit 1 }
  Write-Host "PASS: $name" -ForegroundColor Green
}

$scripts = (Get-Content package.json -Raw | ConvertFrom-Json).scripts
function Has($s) { return $null -ne $scripts.$s }

git status --short | Tee-Object -FilePath (Join-Path $out "git-status-before.txt")

Step "install" { npm ci }
if (Has "typecheck") { Step "typecheck" { npm run typecheck } }
if (Has "lint") { Step "lint" { npm run lint } }
Step "tests" { npm test }
if (Has "build") { Step "build" { npm run build } }
if (Has "acceptance:save") { Step "official acceptance" { npm run acceptance:save } }
elseif (Test-Path "official/run.py") { Step "official acceptance" { python official/run.py .dogfood.toml } }
if (Has "probe") { Step "route probe" { npm run probe } }
if (Has "test:e2e") { Step "browser smoke" { npm run test:e2e } }

if (Get-Command docker -ErrorAction SilentlyContinue) {
  Step "container build and up" { docker compose up --build -d }
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -UseBasicParsing http://localhost:8080/healthz | Out-Null; break } catch { Start-Sleep -Seconds 2 }
  }
  if (Test-Path "official/run.py") { Step "acceptance against container" { python official/run.py .dogfood.toml } }
  docker compose down | Out-Null
} else {
  Write-Host "Docker not found: container proof will come from the CI workflow instead." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force ".github/workflows" | Out-Null
Copy-Item (Join-Path $here "container-proof.yml") ".github/workflows/container-proof.yml" -Force

git add -A
git commit -m "freeze: final verification evidence and container-proof workflow"
git tag -f submission-freeze
if (git remote) {
  git push -u origin HEAD
  git push origin submission-freeze -f
  Write-Host "`nPushed. Open the Actions tab: a green 'container-proof' run is your container evidence." -ForegroundColor Green
} else {
  Write-Host "`nNo git remote. Create an empty GitHub repo, then:" -ForegroundColor Yellow
  Write-Host "  git remote add origin https://github.com/vaibhav4046/dogfood-2026.git"
  Write-Host "  git push -u origin HEAD; git push origin submission-freeze"
}
Write-Host "Evidence logs are in $out\. Frozen." -ForegroundColor Green
