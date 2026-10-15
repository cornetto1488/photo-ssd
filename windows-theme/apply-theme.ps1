# ZALET HOME: чёрно-оранжевая тема Windows. Меняет только ВАШ профиль (без прав администратора), всё можно откатить restore-theme.
# Параметр -AllFolders дополнительно меняет иконку ВСЕХ папок (нужно подтвердить окно UAC).
param([switch]$AllFolders)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dst = Join-Path $env:LOCALAPPDATA 'ZALET\theme'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item (Join-Path $here 'icons\*.ico') $dst -Force

function Get-Val($path, $name) { try { (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name } catch { $null } }
$pers = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$dwm = 'HKCU:\Software\Microsoft\Windows\DWM'
$acc = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'
$bin = 'HKCU:\Software\Classes\CLSID\{645FF040-5081-101B-9F08-00AA002F954E}'
$pc = 'HKCU:\Software\Classes\CLSID\{20D04FE0-3AEA-1069-A2D8-08002B30309D}'

# резервная копия прежних значений
$bakFile = Join-Path $dst 'backup.json'
if (-not (Test-Path $bakFile)) {
  $bak = [ordered]@{
    AppsUseLightTheme = Get-Val $pers 'AppsUseLightTheme'; SystemUsesLightTheme = Get-Val $pers 'SystemUsesLightTheme'; ColorPrevalence = Get-Val $pers 'ColorPrevalence'
    DwmAccentColor = Get-Val $dwm 'AccentColor'; DwmColorizationColor = Get-Val $dwm 'ColorizationColor'; DwmAfterglow = Get-Val $dwm 'ColorizationAfterglow'
    AccentColorMenu = Get-Val $acc 'AccentColorMenu'; AccentPalette = $null
    BinHadIcon = (Test-Path "$bin\DefaultIcon"); PcHadIcon = (Test-Path "$pc\DefaultIcon")
  }
  $bak | ConvertTo-Json | Set-Content -Path $bakFile -Encoding UTF8
}

# тёмный режим, оранжевый акцент (#FF5A1F), без заливки панели задач акцентом
New-Item -Force -Path $pers | Out-Null
Set-ItemProperty -Path $pers -Name AppsUseLightTheme -Value 0 -Type DWord
Set-ItemProperty -Path $pers -Name SystemUsesLightTheme -Value 0 -Type DWord
Set-ItemProperty -Path $pers -Name ColorPrevalence -Value 0 -Type DWord
$abgr = 0xFF1F5AFF   # A=FF B=1F G=5A R=FF
New-Item -Force -Path $dwm | Out-Null
Set-ItemProperty -Path $dwm -Name AccentColor -Value ([int]$abgr) -Type DWord
Set-ItemProperty -Path $dwm -Name ColorizationColor -Value ([int]$abgr) -Type DWord
Set-ItemProperty -Path $dwm -Name ColorizationAfterglow -Value ([int]$abgr) -Type DWord
New-Item -Force -Path $acc | Out-Null
Set-ItemProperty -Path $acc -Name AccentColorMenu -Value ([int]$abgr) -Type DWord

# иконки корзины и «Этот компьютер» (только для вашего пользователя)
New-Item -Force -Path "$bin\DefaultIcon" | Out-Null
Set-ItemProperty -Path "$bin\DefaultIcon" -Name '(Default)' -Value (Join-Path $dst 'recycle-full.ico')
Set-ItemProperty -Path "$bin\DefaultIcon" -Name 'full' -Value (Join-Path $dst 'recycle-full.ico')
Set-ItemProperty -Path "$bin\DefaultIcon" -Name 'empty' -Value (Join-Path $dst 'recycle-empty.ico')
New-Item -Force -Path "$pc\DefaultIcon" | Out-Null
Set-ItemProperty -Path "$pc\DefaultIcon" -Name '(Default)' -Value (Join-Path $dst 'pc.ico')

if ($AllFolders) {
  $folderIco = Join-Path $dst 'folder.ico'
  $cmd = "`$k='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Icons'; New-Item -Force -Path `$k | Out-Null; Set-ItemProperty -Path `$k -Name '3' -Value '$folderIco' -Type String; Set-ItemProperty -Path `$k -Name '4' -Value '$folderIco' -Type String"
  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd -Wait
}

# обновить значки и оформление
& ie4uinit.exe -show
Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force   # Проводник перезапустится сам
Write-Host ''
Write-Host 'Готово: чёрно-оранжевая тема применена.' -ForegroundColor Green
Write-Host 'Вернуть как было: restore-theme.cmd' -ForegroundColor Yellow
if (-not $env:ZALET_NOPAUSE) { Read-Host 'Нажми Enter, чтобы закрыть' }