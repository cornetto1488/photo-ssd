# ZALET HOME: доводит тему до конца (оранжевый акцент, тёмные «Пуск» и панель задач, обновление иконок). Только ваш профиль, без прав администратора.
$ErrorActionPreference = 'Stop'
$dst = Join-Path $env:LOCALAPPDATA 'ZALET\theme'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
function Get-Val($path, $name) { try { (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name } catch { $null } }
function Dw([byte]$r, [byte]$g, [byte]$b, [byte]$a) { [BitConverter]::ToInt32([byte[]]($r, $g, $b, $a), 0) }   # значение ABGR для реестра
$acc = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'
$dwm = 'HKCU:\Software\Microsoft\Windows\DWM'
$pers = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$desk = 'HKCU:\Control Panel\Desktop'

# резервная копия (один раз)
$bak2 = Join-Path $dst 'backup2.json'
if (-not (Test-Path $bak2)) {
  $pal = Get-Val $acc 'AccentPalette'
  [ordered]@{ AutoColorization = Get-Val $desk 'AutoColorization'; StartColorMenu = Get-Val $acc 'StartColorMenu'; AccentColorMenu = Get-Val $acc 'AccentColorMenu'
    AccentPalette = $(if ($pal) { [Convert]::ToBase64String($pal) } else { $null }); ColorPrevalence = Get-Val $pers 'ColorPrevalence'; DwmAccent = Get-Val $dwm 'AccentColor'; DwmColorization = Get-Val $dwm 'ColorizationColor' } | ConvertTo-Json | Set-Content $bak2 -Encoding UTF8
}

# 1. запрещаем Windows подбирать акцент по обоям
Set-ItemProperty -Path $desk -Name AutoColorization -Value 0 -Type DWord
# 2. палитра оранжевого (8 оттенков, RGBA) и основные цвета
$shades = @(@(0xFF,0xC9,0xA8), @(0xFF,0xA9,0x7A), @(0xFF,0x85,0x48), @(0xFF,0x5A,0x1F), @(0xE0,0x48,0x0F), @(0xB5,0x3A,0x0B), @(0x8A,0x2C,0x08), @(0x5C,0x1D,0x05))
$bytes = New-Object System.Collections.Generic.List[byte]
foreach ($c in $shades) { $bytes.Add([byte]$c[0]); $bytes.Add([byte]$c[1]); $bytes.Add([byte]$c[2]); $bytes.Add([byte]0xFF) }
New-Item -Force -Path $acc | Out-Null
Set-ItemProperty -Path $acc -Name AccentPalette -Value ([byte[]]$bytes.ToArray()) -Type Binary
Set-ItemProperty -Path $acc -Name AccentColorMenu -Value (Dw 0xFF 0x5A 0x1F 0xFF) -Type DWord
Set-ItemProperty -Path $acc -Name StartColorMenu -Value (Dw 0x14 0x0A 0x06 0xFF) -Type DWord     # почти чёрный тёплый — для «Пуска» и панели задач
Set-ItemProperty -Path $dwm -Name AccentColor -Value (Dw 0xFF 0x5A 0x1F 0xFF) -Type DWord
Set-ItemProperty -Path $dwm -Name ColorizationColor -Value ([BitConverter]::ToInt32([byte[]](0x1F, 0x5A, 0xFF, 0xC4), 0)) -Type DWord
Set-ItemProperty -Path $dwm -Name ColorPrevalence -Value 1 -Type DWord
# 3. тёмный режим + цвет на «Пуске» и панели задач
Set-ItemProperty -Path $pers -Name AppsUseLightTheme -Value 0 -Type DWord
Set-ItemProperty -Path $pers -Name SystemUsesLightTheme -Value 0 -Type DWord
Set-ItemProperty -Path $pers -Name ColorPrevalence -Value 1 -Type DWord

# 4. пересобираем кеш иконок, чтобы папки на рабочем столе тоже обновились
Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'IconCache.db') -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer') -Filter 'iconcache_*.db' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
& ie4uinit.exe -show
Start-Sleep -Seconds 1
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
Write-Host 'Готово. Если «Пуск» ещё серый — выйдите из Windows и войдите снова (или перезагрузите ПК).' -ForegroundColor Green
if (-not $env:ZALET_NOPAUSE) { Read-Host 'Нажми Enter, чтобы закрыть' }