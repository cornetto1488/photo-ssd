# ZALET HOME — тема Windows в стиле сайта: чёрный «Пуск» и панель задач, оранжевые акцент и выделение,
# свои иконки (корзина, «Этот компьютер», сеть, папки пользователя и рабочего стола) и курсоры.
# Меняет только профиль текущего пользователя. Перед изменением сохраняет каждое прежнее значение,
# поэтому «-Mode restore» возвращает всё в точности как было.
#   zalet-theme.ps1 -Mode apply [-Solid] [-NoCursors] [-AllFolders]
#   zalet-theme.ps1 -Mode restore
param(
  [ValidateSet('apply', 'restore')][string]$Mode = 'apply',
  [switch]$Solid,        # без прозрачности (сплошной чёрный)
  [switch]$NoCursors,    # не менять курсоры
  [switch]$AllFolders,   # иконка для ВСЕХ папок (нужно подтвердить окно администратора)
  [switch]$NoExplorerRestart
)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dst = Join-Path $env:LOCALAPPDATA 'ZALET\theme'
$bakFile = Join-Path $dst 'zalet-theme-backup.json'
$iniBak = Join-Path $dst 'ini-backup'
New-Item -ItemType Directory -Force -Path $dst, $iniBak | Out-Null
$HK = [Microsoft.Win32.Registry]::CurrentUser

Add-Type -Namespace ZaletTheme -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint a, uint b, System.IntPtr c, uint d);
[DllImport("user32.dll", SetLastError = true)] public static extern bool SetSysColors(int n, int[] el, int[] rgb);
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint msg, System.UIntPtr w, string l, uint flags, uint timeout, out System.UIntPtr result);
'@

# ---------- резервная копия ----------
$bak = [ordered]@{ values = [ordered]@{}; files = [ordered]@{}; readonlyDirs = @() }
if (Test-Path $bakFile) {
  $j = Get-Content $bakFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($p in $j.values.PSObject.Properties) { $bak.values[$p.Name] = $p.Value }
  foreach ($p in $j.files.PSObject.Properties) { $bak.files[$p.Name] = $p.Value }
  $bak.readonlyDirs = @($j.readonlyDirs)
}
function Save-Bak { $bak | ConvertTo-Json -Depth 6 | Set-Content -Path $bakFile -Encoding UTF8 }

function Save-Orig([string]$sub, [string]$name) {
  $key = "$sub|$name"
  if ($bak.values.Contains($key)) { return }
  $e = [ordered]@{ sub = $sub; name = $name; exists = $false; kind = $null; value = $null }
  $k = $HK.OpenSubKey($sub)
  if ($k) {
    $v = $k.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
    if ($null -ne $v) {
      $kind = $k.GetValueKind($name).ToString()
      $e.exists = $true; $e.kind = $kind
      $e.value = if ($kind -eq 'Binary') { [Convert]::ToBase64String([byte[]]$v) } else { $v }
    }
    $k.Close()
  }
  $bak.values[$key] = $e
}
function Set-V([string]$sub, [string]$name, $value, [Microsoft.Win32.RegistryValueKind]$kind) {
  Save-Orig $sub $name; Save-Bak
  $k = $HK.CreateSubKey($sub); $k.SetValue($name, $value, $kind); $k.Close()
}
function Dw([byte]$r, [byte]$g, [byte]$b, [byte]$a) { [BitConverter]::ToInt32([byte[]]($r, $g, $b, $a), 0) }
function RgbInt([int]$r, [int]$g, [int]$b) { $r + ($g -shl 8) + ($b -shl 16) }

# desktop.ini: меняем только строку IconResource, остальное (название папки и т.п.) сохраняем
function Set-FolderIcon([string]$dir, [string]$ico) {
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  $ini = Join-Path $dir 'desktop.ini'
  if (-not $bak.files.Contains($ini)) {
    if (Test-Path -LiteralPath $ini) {
      $copy = Join-Path $iniBak ([guid]::NewGuid().ToString() + '.ini')
      attrib -h -s "$ini"; Copy-Item -LiteralPath $ini -Destination $copy -Force
      $bak.files[$ini] = [ordered]@{ existed = $true; copy = $copy }
    } else { $bak.files[$ini] = [ordered]@{ existed = $false; copy = $null } }
    $attr = (Get-Item -LiteralPath $dir -Force).Attributes
    if (-not ($attr -band [IO.FileAttributes]::ReadOnly) -and -not ($attr -band [IO.FileAttributes]::System)) { $bak.readonlyDirs += $dir }
    Save-Bak
  }
  $lines = @()
  if (Test-Path -LiteralPath $ini) { attrib -h -s "$ini"; $lines = @(Get-Content -LiteralPath $ini) }
  $lines = @($lines | Where-Object { $_ -notmatch '^\s*IconResource\s*=' -and $_ -notmatch '^\s*IconFile\s*=' -and $_ -notmatch '^\s*IconIndex\s*=' })
  $i = [Array]::FindIndex([string[]]$lines, [Predicate[string]] { param($l) $l -match '^\s*\[\.ShellClassInfo\]' })
  if ($i -lt 0) { $lines = @('[.ShellClassInfo]', "IconResource=$ico,0") + $lines }
  else { $lines = @($lines[0..$i]) + @("IconResource=$ico,0") + $(if ($i + 1 -lt $lines.Count) { @($lines[($i + 1)..($lines.Count - 1)]) } else { @() }) }
  Set-Content -LiteralPath $ini -Value $lines -Encoding Unicode
  attrib +h +s "$ini"; attrib +r "$dir"
}

function Refresh-Shell([switch]$Restart) {
  $r = [UIntPtr]::Zero
  foreach ($m in 'ImmersiveColorSet', 'WindowsThemeElement', 'Environment') { [void][ZaletTheme.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, $m, 2, 3000, [ref]$r) }
  & ie4uinit.exe -show
  if ($Restart -and -not $NoExplorerRestart) {
    Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $cache = @(Join-Path $env:LOCALAPPDATA 'IconCache.db') + @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer') -Filter 'iconcache_*.db' -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($c in $cache) { if (Test-Path $c) { try { [IO.File]::Delete($c) } catch { } } }
    Start-Sleep -Seconds 1
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
  }
}

$kPers = 'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$kAcc = 'Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'
$kDwm = 'Software\Microsoft\Windows\DWM'
$kCol = 'Control Panel\Colors'
$kCur = 'Control Panel\Cursors'
$kClsid = 'Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID'
$shellIcons = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Icons'

if ($Mode -eq 'apply') {
  # файлы иконок и курсоров — в постоянную папку профиля
  $ico = Join-Path $dst 'icons'; $cur = Join-Path $dst 'cursors'
  New-Item -ItemType Directory -Force -Path $ico, $cur | Out-Null
  Copy-Item (Join-Path $src 'icons\*.ico') $ico -Force
  if (Test-Path (Join-Path $src 'cursors')) { Copy-Item (Join-Path $src 'cursors\*.cur') $cur -Force }
  Write-Host '• Тёмный режим, чёрный «Пуск» и панель задач, оранжевый акцент'
  Set-V $kPers 'AppsUseLightTheme' 0 DWord
  Set-V $kPers 'SystemUsesLightTheme' 0 DWord
  Set-V $kPers 'ColorPrevalence' 0 DWord          # «Пуск» и панель задач — чёрные, без заливки акцентом
  if ($Solid) { Set-V $kPers 'EnableTransparency' 0 DWord }
  Set-V 'Control Panel\Desktop' 'AutoColorization' 0 DWord   # не подбирать цвет по обоям
  $shades = @(@(0xFF,0xC9,0xA8), @(0xFF,0xA9,0x7A), @(0xFF,0x85,0x48), @(0xFF,0x5A,0x1F), @(0xE0,0x48,0x0F), @(0xB5,0x3A,0x0B), @(0x8A,0x2C,0x08), @(0x5C,0x1D,0x05))
  $pal = New-Object System.Collections.Generic.List[byte]; foreach ($c in $shades) { $pal.AddRange([byte[]]@($c[0], $c[1], $c[2], 0xFF)) }
  Set-V $kAcc 'AccentPalette' ([byte[]]$pal.ToArray()) Binary
  Set-V $kAcc 'AccentColorMenu' (Dw 0xFF 0x5A 0x1F 0xFF) DWord
  Set-V $kAcc 'StartColorMenu' (Dw 0x0B 0x0B 0x0E 0xFF) DWord
  Set-V $kDwm 'AccentColor' (Dw 0xFF 0x5A 0x1F 0xFF) DWord
  Set-V $kDwm 'ColorizationColor' ([BitConverter]::ToInt32([byte[]](0x1F, 0x5A, 0xFF, 0xC4), 0)) DWord
  Set-V $kDwm 'ColorizationAfterglow' ([BitConverter]::ToInt32([byte[]](0x1F, 0x5A, 0xFF, 0xC4), 0)) DWord
  Set-V $kDwm 'ColorPrevalence' 0 DWord          # заголовки окон тёмные

  Write-Host '• Цвет выделения и подсветки — оранжевый'
  Set-V $kCol 'Hilight' '255 90 31' String
  Set-V $kCol 'HilightText' '255 255 255' String
  Set-V $kCol 'HotTrackingColor' '255 120 60' String
  Set-V $kCol 'MenuHilight' '255 90 31' String
  [void][ZaletTheme.Native]::SetSysColors(4, @(13, 14, 26, 29), @((RgbInt 255 90 31), (RgbInt 255 255 255), (RgbInt 255 120 60), (RgbInt 255 90 31)))

  Write-Host '• Иконки: корзина, «Этот компьютер», сеть, папка пользователя'
  $bin = "$kClsid\{645FF040-5081-101B-9F08-00AA002F954E}\DefaultIcon"
  Set-V $bin '' "$ico\recycle-full.ico,0" ExpandString
  Set-V $bin 'full' "$ico\recycle-full.ico,0" ExpandString
  Set-V $bin 'empty' "$ico\recycle-empty.ico,0" ExpandString
  Set-V "$kClsid\{20D04FE0-3AEA-1069-A2D8-08002B30309D}\DefaultIcon" '' "$ico\pc.ico,0" ExpandString
  Set-V "$kClsid\{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}\DefaultIcon" '' "$ico\network.ico,0" ExpandString
  Set-V "$kClsid\{59031a47-3f72-44a7-89c5-5595fe6b30ee}\DefaultIcon" '' "$ico\user.ico,0" ExpandString

  Write-Host '• Иконки папок: Документы, Загрузки, Изображения, Музыка, Видео, Рабочий стол и папки на рабочем столе'
  $downloads = try { (New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path } catch { Join-Path $env:USERPROFILE 'Downloads' }
  $known = @(
    @([Environment]::GetFolderPath('MyDocuments'), 'folder-docs'), @($downloads, 'folder-downloads'),
    @([Environment]::GetFolderPath('MyPictures'), 'folder-pictures'), @([Environment]::GetFolderPath('MyMusic'), 'folder-music'),
    @([Environment]::GetFolderPath('MyVideos'), 'folder-videos'), @([Environment]::GetFolderPath('Desktop'), 'folder-desktop'))
  foreach ($k in $known) { try { Set-FolderIcon $k[0] "$ico\$($k[1]).ico" } catch { Write-Host "  пропуск: $($k[0])" } }
  foreach ($dir in Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Directory -Force -ErrorAction SilentlyContinue) {
    try { Set-FolderIcon $dir.FullName "$ico\folder.ico" } catch { Write-Host "  пропуск: $($dir.FullName)" }
  }

  if (-not $NoCursors -and (Test-Path "$cur\arrow.cur")) {
    Write-Host '• Курсоры ZALET'
    $map = [ordered]@{ Arrow = 'arrow'; Hand = 'link'; IBeam = 'ibeam'; Crosshair = 'cross'; Wait = 'wait'; AppStarting = 'busy'; No = 'no'; SizeNS = 'size-ns'; SizeWE = 'size-we'; SizeNWSE = 'size-nwse'; SizeNESW = 'size-nesw'; SizeAll = 'size-all' }
    Set-V $kCur '' 'ZALET' String
    foreach ($n in $map.Keys) { Set-V $kCur $n "$cur\$($map[$n]).cur" ExpandString }
    [void][ZaletTheme.Native]::SystemParametersInfo(0x57, 0, [IntPtr]::Zero, 3)
  }

  if ($AllFolders) {
    Write-Host '• Иконка для всех папок (подтвердите окно администратора)'
    $f = "$ico\folder.ico"
    $cmd = "`$k='$shellIcons'; New-Item -Force -Path `$k | Out-Null; Set-ItemProperty -Path `$k -Name '3' -Value '$f'; Set-ItemProperty -Path `$k -Name '4' -Value '$f'"
    try { Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd } catch { Write-Host '  отменено' }
  }
  Save-Bak
  Refresh-Shell -Restart
  Write-Host 'Готово. Если «Пуск» не обновился сразу — выйдите из Windows и войдите снова.' -ForegroundColor Green
}
else {
  if (-not (Test-Path $bakFile)) { Write-Host 'Тема ZALET не применялась — возвращать нечего.'; exit 0 }
  Write-Host '• Возвращаю прежние настройки'
  foreach ($e in $bak.values.Values) {
    $k = $HK.OpenSubKey($e.sub, $true)
    if ($e.exists) {
      if (-not $k) { $k = $HK.CreateSubKey($e.sub) }
      $kind = [Microsoft.Win32.RegistryValueKind]$e.kind
      $v = switch ($e.kind) { 'Binary' { [Convert]::FromBase64String($e.value) } 'DWord' { [int]$e.value } 'QWord' { [long]$e.value } 'MultiString' { [string[]]$e.value } default { [string]$e.value } }
      $k.SetValue($e.name, $v, $kind)
    } elseif ($k) { $k.DeleteValue($e.name, $false) }
    if ($k) { $k.Close() }
  }
  foreach ($ini in $bak.files.Keys) {
    $f = $bak.files[$ini]
    try {
      if (Test-Path -LiteralPath $ini) { attrib -h -s "$ini" }
      if ($f.existed -and $f.copy -and (Test-Path -LiteralPath $f.copy)) { Copy-Item -LiteralPath $f.copy -Destination $ini -Force; attrib +h +s "$ini" }
      elseif (-not $f.existed -and (Test-Path -LiteralPath $ini)) { [IO.File]::Delete($ini) }
    } catch { Write-Host "  не удалось вернуть $ini" }
  }
  foreach ($dir in $bak.readonlyDirs) { if ($dir -and (Test-Path -LiteralPath $dir)) { attrib -r "$dir" } }
  $c = $HK.OpenSubKey($kCol)
  $toInt = { param($s) $p = "$s" -split '\s+'; if ($p.Count -ge 3) { RgbInt ([int]$p[0]) ([int]$p[1]) ([int]$p[2]) } else { 0 } }
  [void][ZaletTheme.Native]::SetSysColors(4, @(13, 14, 26, 29), @((& $toInt $c.GetValue('Hilight')), (& $toInt $c.GetValue('HilightText')), (& $toInt $c.GetValue('HotTrackingColor')), (& $toInt $c.GetValue('MenuHilight'))))
  $c.Close()
  [void][ZaletTheme.Native]::SystemParametersInfo(0x57, 0, [IntPtr]::Zero, 3)
  if (Get-ItemProperty -Path $shellIcons -Name '3' -ErrorAction SilentlyContinue) {
    $cmd = "Remove-ItemProperty -Path '$shellIcons' -Name '3','4' -ErrorAction SilentlyContinue"
    try { Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd } catch { }
  }
  Move-Item -LiteralPath $bakFile -Destination ($bakFile + '.restored-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
  Refresh-Shell -Restart
  Write-Host 'Готово: прежняя тема, иконки и курсоры возвращены.' -ForegroundColor Green
}
if (-not $env:ZALET_NOPAUSE) { Read-Host 'Нажми Enter, чтобы закрыть' }
