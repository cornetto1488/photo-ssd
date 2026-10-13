# ZALET HOME — сделать флешку: форматирует выбранную флешку и записывает на неё всё для входа домой.
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Kit  = Join-Path (Split-Path -Parent $Here) "флешка"
$Host.UI.RawUI.WindowTitle = "ZALET HOME — создание флешки"
function Fail($t) { Write-Host ""; Write-Host "  ✕ $t" -ForegroundColor Red; Read-Host "  Нажмите Enter" | Out-Null; exit 1 }

Clear-Host
Write-Host ""; Write-Host "   ZA" -ForegroundColor DarkYellow -NoNewline; Write-Host "LET HOME · флешка в один клик"; Write-Host ""
if (-not (Test-Path $Kit)) { Fail "Не найдена папка «флешка» рядом с этим файлом — распакуйте архив целиком" }

$usb = @(Get-Disk | Where-Object { $_.BusType -eq "USB" -and -not $_.IsBoot -and -not $_.IsSystem })
if (-not $usb.Count) { Fail "Вставьте флешку и запустите ещё раз" }
$vols = @()
foreach ($d in $usb) {
    foreach ($p in (Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | Where-Object DriveLetter)) {
        $v = Get-Volume -DriveLetter $p.DriveLetter
        $vols += [pscustomobject]@{ Letter = $p.DriveLetter; Disk = $d.Number; Name = $d.FriendlyName.Trim(); GB = [math]::Round($d.Size / 1GB, 1); Label = $v.FileSystemLabel }
    }
}
if (-not $vols.Count) { Fail "У флешки нет буквы диска — откройте «Управление дисками» и назначьте букву" }
for ($i = 0; $i -lt $vols.Count; $i++) {
    "  {0}) {1}:  {2}  {3} ГБ  «{4}»" -f ($i + 1), $vols[$i].Letter, $vols[$i].Name, $vols[$i].GB, $vols[$i].Label | Write-Host
}
Write-Host ""
$n = if ($vols.Count -eq 1) { 1 } else { [int](Read-Host "  Какую флешку использовать? Номер") }
$t = $vols[$n - 1]; if (-not $t) { Fail "Нет такого номера" }
Write-Host ""
Write-Host ("  ВСЁ на флешке {0}: ({1}, {2} ГБ) будет стёрто." -f $t.Letter, $t.Name, $t.GB) -ForegroundColor Yellow
if ((Read-Host "  Напишите ДА, чтобы продолжить") -ne "ДА") { Fail "Отменено" }

Write-Host "  Форматирую…" -ForegroundColor Yellow
Format-Volume -DriveLetter $t.Letter -FileSystem exFAT -NewFileSystemLabel "ZALET HOME" -Confirm:$false -Force | Out-Null
Write-Host "  Записываю файлы…" -ForegroundColor Yellow
$dst = "$($t.Letter):\"
Copy-Item (Join-Path $Kit "*") $dst -Recurse -Force
Get-ChildItem $Kit -Force | Where-Object { $_.Name -like ".*" } | ForEach-Object { Copy-Item $_.FullName $dst -Recurse -Force }
attrib +h +s "$($t.Letter):\.zalet" 2>$null
attrib +h +s "$($t.Letter):\autorun.inf" 2>$null
Write-Host ""; Write-Host "  ✓ Флешка ZALET HOME готова!" -ForegroundColor Green
Write-Host "  Вставьте её в любой компьютер и запустите «ZALET HOME» (Windows), zalet-linux.sh (Linux) или «ZALET HOME (Mac)»." -ForegroundColor Gray
Write-Host ""; Read-Host "  Нажмите Enter, чтобы закрыть" | Out-Null
