# Возвращает прежнюю тему и иконки (значения берутся из резервной копии, созданной apply-theme).
$ErrorActionPreference = 'SilentlyContinue'
$dst = Join-Path $env:LOCALAPPDATA 'ZALET\theme'
$bakFile = Join-Path $dst 'backup.json'
$pers = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$dwm = 'HKCU:\Software\Microsoft\Windows\DWM'
$acc = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'
$bin = 'HKCU:\Software\Classes\CLSID\{645FF040-5081-101B-9F08-00AA002F954E}'
$pc = 'HKCU:\Software\Classes\CLSID\{20D04FE0-3AEA-1069-A2D8-08002B30309D}'
function SetOrDel($path, $name, $val) { if ($null -eq $val) { Remove-ItemProperty -Path $path -Name $name } else { Set-ItemProperty -Path $path -Name $name -Value ([int]$val) -Type DWord } }
if (Test-Path $bakFile) {
  $b = Get-Content $bakFile -Raw | ConvertFrom-Json
  SetOrDel $pers 'AppsUseLightTheme' $b.AppsUseLightTheme; SetOrDel $pers 'SystemUsesLightTheme' $b.SystemUsesLightTheme; SetOrDel $pers 'ColorPrevalence' $b.ColorPrevalence
  SetOrDel $dwm 'AccentColor' $b.DwmAccentColor; SetOrDel $dwm 'ColorizationColor' $b.DwmColorizationColor; SetOrDel $dwm 'ColorizationAfterglow' $b.DwmAfterglow
  SetOrDel $acc 'AccentColorMenu' $b.AccentColorMenu
}
$bak2 = Join-Path $dst 'backup2.json'
if (Test-Path $bak2) {
  $c = Get-Content $bak2 -Raw | ConvertFrom-Json
  SetOrDel 'HKCU:\Control Panel\Desktop' 'AutoColorization' $c.AutoColorization
  SetOrDel $acc 'StartColorMenu' $c.StartColorMenu; SetOrDel $acc 'AccentColorMenu' $c.AccentColorMenu
  if ($c.AccentPalette) { Set-ItemProperty -Path $acc -Name AccentPalette -Value ([Convert]::FromBase64String($c.AccentPalette)) -Type Binary }
  SetOrDel $pers 'ColorPrevalence' $c.ColorPrevalence; SetOrDel $dwm 'AccentColor' $c.DwmAccent; SetOrDel $dwm 'ColorizationColor' $c.DwmColorization
}Remove-Item -Path "$bin\DefaultIcon" -Recurse -Force
Remove-Item -Path "$pc\DefaultIcon" -Recurse -Force
$cmd = "Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Icons' -Name '3' -ErrorAction SilentlyContinue; Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Icons' -Name '4' -ErrorAction SilentlyContinue"
$k = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Icons' -Name '3' -ErrorAction SilentlyContinue
if ($k) { Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd -Wait }
& ie4uinit.exe -show
Get-Process explorer | Stop-Process -Force
Write-Host 'Готово: прежняя тема и иконки возвращены.' -ForegroundColor Green
Read-Host 'Нажми Enter, чтобы закрыть'