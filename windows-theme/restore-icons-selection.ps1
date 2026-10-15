# Откат шага theme-icons-selection: прежние иконки корзины / ПК / папок на рабочем столе и прежний цвет выделения.
$ErrorActionPreference = 'SilentlyContinue'
$dst = Join-Path $env:LOCALAPPDATA 'ZALET\theme'
$bak3 = Join-Path $dst 'backup3.json'
$expl = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID'
if (Test-Path $bak3) {
  $c3 = Get-Content $bak3 -Raw | ConvertFrom-Json
  foreach ($pair in @(@("$expl\{645FF040-5081-101B-9F08-00AA002F954E}\DefaultIcon", $c3.Bin), @("$expl\{20D04FE0-3AEA-1069-A2D8-08002B30309D}\DefaultIcon", $c3.Pc))) {
    $k = $pair[0]; $v = $pair[1]
    if ($null -eq $v) { Remove-Item -Path $k -Recurse -Force }
    else { New-Item -Force -Path $k | Out-Null; $v.PSObject.Properties | ForEach-Object { Set-ItemProperty -Path $k -Name $(if ($_.Name -eq '(default)') { '(Default)' } else { $_.Name }) -Value $_.Value } }
  }
  foreach ($n in 'Hilight', 'HilightText', 'HotTrackingColor', 'MenuHilight') { if ($c3.$n) { Set-ItemProperty -Path 'HKCU:\Control Panel\Colors' -Name $n -Value $c3.$n } }
}
foreach ($dir in Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Directory -Force) {
  $ini = Join-Path $dir.FullName 'desktop.ini'
  if (Test-Path "$ini.zalet-bak") { attrib -h -s "$ini"; attrib -h "$ini.zalet-bak"; Move-Item "$ini.zalet-bak" $ini -Force; attrib +h +s "$ini" }
  elseif (Test-Path "$ini.zalet-new") { attrib -h -s "$ini"; [IO.File]::Delete($ini); attrib -h "$ini.zalet-new"; [IO.File]::Delete("$ini.zalet-new"); attrib -r "$($dir.FullName)" }
}
& ie4uinit.exe -show
Get-Process explorer | Stop-Process -Force
Write-Host 'Готово: прежние иконки и цвет выделения возвращены (цвет — после повторного входа в Windows).' -ForegroundColor Green
Read-Host 'Нажми Enter, чтобы закрыть'
