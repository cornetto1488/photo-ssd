# ZALET HOME — отключиться от дома (и по желанию удалить Tailscale с этого компьютера).
$TS = "$env:ProgramFiles\Tailscale\tailscale.exe"
$Host.UI.RawUI.WindowTitle = "ZALET HOME — отключение"
Write-Host ""
if (-not (Test-Path $TS)) { Write-Host "  Tailscale на этом компьютере не установлен." -ForegroundColor Gray; Start-Sleep 3; exit }
Write-Host "  1 — отключиться от дома (компьютер выйдет из сети)"
Write-Host "  2 — отключиться и удалить Tailscale с компьютера (не оставлять следов)"
Write-Host ""
$c = Read-Host "  Выберите 1 или 2"
& $TS logout 2>&1 | Out-Null
Write-Host "  ✓ Отключено от домашней сети" -ForegroundColor Green
if ($c -eq "2") {
    Write-Host "  Удаляю Tailscale…" -ForegroundColor Yellow
    $app = Get-CimInstance Win32_Product -Filter "Name like 'Tailscale%'" -ErrorAction SilentlyContinue
    if ($app) { Start-Process msiexec.exe -ArgumentList "/x $($app.IdentifyingNumber) /qn /norestart" -Wait }
    Write-Host "  ✓ Tailscale удалён" -ForegroundColor Green
}
Start-Sleep 3
