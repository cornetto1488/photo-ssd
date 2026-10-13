# ZALET HOME — флешка: ставит Tailscale (если нужно), подключает к домашней сети и открывает панель.
$ErrorActionPreference = "Continue"
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Router  = "100.113.69.110"
$Portal  = "http://$Router/"
$TS      = "$env:ProgramFiles\Tailscale\tailscale.exe"
$KeyFile = Join-Path $Here "key.txt"
$Host.UI.RawUI.WindowTitle = "ZALET HOME"

function Say($t, $c = "Gray") { Write-Host "  $t" -ForegroundColor $c }
function Done($t) { Write-Host "  ✓ $t" -ForegroundColor Green }
function Fail($t) {
    Write-Host ""; Write-Host "  ✕ $t" -ForegroundColor Red; Write-Host ""
    Read-Host "  Нажмите Enter, чтобы закрыть" | Out-Null; exit 1
}

Clear-Host
Write-Host ""
Write-Host "   ZA" -ForegroundColor DarkYellow -NoNewline; Write-Host "LET " -NoNewline; Write-Host "HOME" -ForegroundColor DarkGray
Write-Host "   подключаюсь к дому…" -ForegroundColor DarkGray
Write-Host ""

# 0. Уже дома? (тот же Wi-Fi или Tailscale уже подключён) — сразу открываем
function Reach { try { (Invoke-WebRequest -Uri $Portal -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }
if (Reach) { Done "Связь с домом уже есть"; Start-Process $Portal; Start-Sleep 1; exit 0 }

# 1. Tailscale
if (-not (Test-Path $TS)) {
    $msi = Join-Path $Here "tailscale-setup-amd64.msi"
    if (-not (Test-Path $msi)) { Fail "На флешке нет установщика Tailscale (.zalet\tailscale-setup-amd64.msi)" }
    Say "Устанавливаю Tailscale с флешки (около минуты)…" Yellow
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart TS_UNATTENDEDMODE=always TS_NOLAUNCH=1" -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "Установка не удалась (код $($p.ExitCode))" }
    for ($i = 0; $i -lt 30 -and -not (Test-Path $TS); $i++) { Start-Sleep 1 }
    Done "Tailscale установлен"
} else { Done "Tailscale уже есть на компьютере" }

# служба должна работать
$svc = Get-Service Tailscale -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne "Running") { Start-Service Tailscale; Start-Sleep 3 }

# 2. Подключение
$st = $null
try { $st = & $TS status --json 2>$null | ConvertFrom-Json } catch {}
if ($st -and $st.BackendState -eq "Running") {
    Done "Tailscale уже подключён"
} else {
    if (-not (Test-Path $KeyFile) -or -not (Get-Content $KeyFile -Raw).Trim()) {
        Fail "Нет ключа подключения: положите его в .zalet\key.txt (см. ПРОЧТИ МЕНЯ.txt)"
    }
    $key = (Get-Content $KeyFile -Raw).Trim()
    $name = ("usb-" + $env:COMPUTERNAME).ToLower() -replace "[^a-z0-9-]", "-"
    Say "Подключаюсь к домашней сети как $name…" Yellow
    $upArgs = @("up", "--authkey=$key", "--unattended", "--hostname=$name", "--accept-routes", "--reset")
    if ($key -like "tskey-client-*") {
        # ключ OAuth: компьютер подключается постоянно (не временно) и без ручного подтверждения
        if ($key -notlike "*`?*") { $upArgs[1] = "--authkey=$key`?ephemeral=false&preauthorized=true" }
        $upArgs += "--advertise-tags=tag:usb"
    }
    & $TS @upArgs 2>&1 | ForEach-Object { Say $_ DarkGray }
    if ($LASTEXITCODE -ne 0) { Fail "Tailscale не подключился. Возможно, ключ устарел — создайте новый (см. ПРОЧТИ МЕНЯ.txt)" }
    Done "Подключено к домашней сети"
}

# 3. Ждём связь с роутером и открываем панель
Say "Жду ответа от дома…" Yellow
for ($i = 0; $i -lt 40; $i++) {
    if (Reach) { Done "Дом на связи"; Start-Process $Portal; Start-Sleep 2; exit 0 }
    Start-Sleep 1
}
Start-Process $Portal
Fail "Роутер пока не ответил — страница открыта, обновите её через минуту"
