# ZALET HOME: иконки корзины / «Этот компьютер» / папок на рабочем столе + цвет выделения в оранжевый. Только ваш профиль.
$ErrorActionPreference = 'Stop'
$dst = Join-Path $env:LOCALAPPDATA 'ZALET\theme'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'icons\*.ico') $dst -Force
$bakFile = Join-Path $dst 'backup3.json'
$expl = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID'
$bin = "$expl\{645FF040-5081-101B-9F08-00AA002F954E}\DefaultIcon"
$pc = "$expl\{20D04FE0-3AEA-1069-A2D8-08002B30309D}\DefaultIcon"
$col = 'HKCU:\Control Panel\Colors'
function Get-Props($p) { if (Test-Path $p) { $o = @{}; (Get-ItemProperty $p).PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $o[$_.Name] = [string]$_.Value }; $o } else { $null } }

# резервная копия (один раз)
if (-not (Test-Path $bakFile)) {
  $c = Get-ItemProperty $col
  [ordered]@{ Bin = Get-Props $bin; Pc = Get-Props $pc; Hilight = $c.Hilight; HilightText = $c.HilightText; HotTrackingColor = $c.HotTrackingColor; MenuHilight = $c.MenuHilight } | ConvertTo-Json -Depth 3 | Set-Content $bakFile -Encoding UTF8
}

# 1. корзина и «Этот компьютер» — в том разделе, который читает рабочий стол (он перебивал прошлую попытку)
New-Item -Force -Path $bin | Out-Null
Set-ItemProperty -Path $bin -Name '(Default)' -Value ((Join-Path $dst 'recycle-full.ico') + ',0')
Set-ItemProperty -Path $bin -Name 'full' -Value ((Join-Path $dst 'recycle-full.ico') + ',0')
Set-ItemProperty -Path $bin -Name 'empty' -Value ((Join-Path $dst 'recycle-empty.ico') + ',0')
New-Item -Force -Path $pc | Out-Null
Set-ItemProperty -Path $pc -Name '(Default)' -Value ((Join-Path $dst 'pc.ico') + ',0')

# 2. папки на рабочем столе: своя иконка через desktop.ini (прежний desktop.ini сохраняется рядом)
$folderIco = Join-Path $dst 'folder.ico'
foreach ($dir in Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Directory -Force) {
  $ini = Join-Path $dir.FullName 'desktop.ini'
  if (Test-Path $ini) {
    if (-not (Test-Path "$ini.zalet-bak")) { attrib -h -s "$ini"; Copy-Item $ini "$ini.zalet-bak" -Force; attrib +h "$ini.zalet-bak" }
    attrib -h -s "$ini"
  } elseif (-not (Test-Path "$ini.zalet-new")) { New-Item -ItemType File -Path "$ini.zalet-new" -Force | Out-Null; attrib +h "$ini.zalet-new" }
  Set-Content -Path $ini -Value "[.ShellClassInfo]`r`nIconResource=$folderIco,0`r`n" -Encoding Unicode
  attrib +h +s "$ini"
  attrib +r "$($dir.FullName)"
}

# 3. цвет выделения и подсветки (текст, списки, меню) — оранжевый
Set-ItemProperty -Path $col -Name Hilight -Value '255 90 31'
Set-ItemProperty -Path $col -Name HilightText -Value '255 255 255'
Set-ItemProperty -Path $col -Name HotTrackingColor -Value '255 90 31'
Set-ItemProperty -Path $col -Name MenuHilight -Value '255 90 31'

# 4. обновить значки: перезапуск Проводника и сброс кеша иконок
Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$cache = @(Join-Path $env:LOCALAPPDATA 'IconCache.db') + @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer') -Filter 'iconcache_*.db' -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
foreach ($c in $cache) { if (Test-Path $c) { [IO.File]::Delete($c) } }
& ie4uinit.exe -show
Start-Sleep -Seconds 1
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
Write-Host 'Готово. Цвет выделения полностью применится после выхода из Windows и входа снова.' -ForegroundColor Green
Read-Host 'Нажми Enter, чтобы закрыть'
