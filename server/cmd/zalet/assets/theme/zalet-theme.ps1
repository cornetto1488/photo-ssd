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
  if ($j.legacyMerged) { $bak['legacyMerged'] = $true }
  if ($j.ssdNav) { $bak['ssdNav'] = $j.ssdNav }
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
# Если раньше применялись старые скрипты темы, настоящие исходные значения лежат в их копиях (backup*.json) —
# берём их, чтобы откат вернул систему к состоянию ДО любых тем ZALET.
$script:SeedForce = $false
function Seed([string]$sub, [string]$name, $exists, $kind, $value) {
  $key = "$sub|$name"
  if ($bak.values.Contains($key) -and -not $script:SeedForce) { return }
  $bak.values[$key] = [ordered]@{ sub = $sub; name = $name; exists = [bool]$exists; kind = $kind; value = $value }
}
function SeedDw([string]$sub, [string]$name, $v) { if ($null -eq $v) { Seed $sub $name $false $null $null } else { Seed $sub $name $true 'DWord' $v } }
function SeedStr([string]$sub, [string]$name, $v, [string]$kind = 'String') { if ($null -eq $v) { Seed $sub $name $false $null $null } else { Seed $sub $name $true $kind ([string]$v) } }
function Seed-Legacy {
  $pers = 'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'; $acc = 'Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'; $dwm = 'Software\Microsoft\Windows\DWM'
  $b1 = Join-Path $dst 'backup.json'; $b2 = Join-Path $dst 'backup2.json'; $b3 = Join-Path $dst 'backup3.json'
  if (Test-Path $b1) {
    $o = Get-Content $b1 -Raw | ConvertFrom-Json
    SeedDw $pers 'AppsUseLightTheme' $o.AppsUseLightTheme; SeedDw $pers 'SystemUsesLightTheme' $o.SystemUsesLightTheme; SeedDw $pers 'ColorPrevalence' $o.ColorPrevalence
    SeedDw $dwm 'AccentColor' $o.DwmAccentColor; SeedDw $dwm 'ColorizationColor' $o.DwmColorizationColor; SeedDw $dwm 'ColorizationAfterglow' $o.DwmAfterglow
    SeedDw $acc 'AccentColorMenu' $o.AccentColorMenu
    $cls = 'Software\Classes\CLSID'
    if (-not $o.BinHadIcon) { foreach ($n in '', 'full', 'empty') { Seed "$cls\{645FF040-5081-101B-9F08-00AA002F954E}\DefaultIcon" $n $false $null $null } }
    if (-not $o.PcHadIcon) { Seed "$cls\{20D04FE0-3AEA-1069-A2D8-08002B30309D}\DefaultIcon" '' $false $null $null }
  }
  if (Test-Path $b2) {
    $o = Get-Content $b2 -Raw | ConvertFrom-Json
    SeedDw 'Control Panel\Desktop' 'AutoColorization' $o.AutoColorization; SeedDw $acc 'StartColorMenu' $o.StartColorMenu; SeedDw $acc 'AccentColorMenu' $o.AccentColorMenu
    if ($o.AccentPalette) { Seed $acc 'AccentPalette' $true 'Binary' $o.AccentPalette } else { Seed $acc 'AccentPalette' $false $null $null }
  }
  if (Test-Path $b3) {
    $o = Get-Content $b3 -Raw | ConvertFrom-Json
    $ex = 'Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID'
    foreach ($pair in @(@("$ex\{645FF040-5081-101B-9F08-00AA002F954E}\DefaultIcon", $o.Bin, @('', 'full', 'empty')), @("$ex\{20D04FE0-3AEA-1069-A2D8-08002B30309D}\DefaultIcon", $o.Pc, @('')))) {
      if ($null -eq $pair[1]) { foreach ($n in $pair[2]) { Seed $pair[0] $n $false $null $null } }
      else { foreach ($p in $pair[1].PSObject.Properties) { SeedStr $pair[0] $(if ($p.Name -eq '(default)') { '' } else { $p.Name }) $p.Value 'ExpandString' } }
    }
    foreach ($n in 'Hilight', 'HilightText', 'HotTrackingColor', 'MenuHilight') { SeedStr 'Control Panel\Colors' $n $o.$n }
  }
}

function Dw([byte]$r, [byte]$g, [byte]$b, [byte]$a) { [BitConverter]::ToInt32([byte[]]($r, $g, $b, $a), 0) }
function RgbInt([int]$r, [int]$g, [int]$b) { $r + ($g -shl 8) + ($b -shl 16) }

# desktop.ini: меняем только строку IconResource, остальное (название папки и т.п.) сохраняем
function Set-FolderIcon([string]$dir, [string]$ico) {
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  $ini = Join-Path $dir 'desktop.ini'
  if (-not $bak.files.Contains($ini)) {
    if (Test-Path -LiteralPath "$ini.zalet-bak") {          # копия от старого скрипта темы — это и есть оригинал
      $bak.files[$ini] = [ordered]@{ existed = $true; copy = "$ini.zalet-bak" }
    } elseif (Test-Path -LiteralPath "$ini.zalet-new") {    # старый скрипт создавал desktop.ini с нуля
      $bak.files[$ini] = [ordered]@{ existed = $false; copy = $null }; $bak.readonlyDirs += $dir
    } elseif (Test-Path -LiteralPath $ini) {
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
  if (-not (Test-Path $bakFile)) { Seed-Legacy; Save-Bak }
  elseif (-not $bak.Contains('legacyMerged') -or -not $bak.legacyMerged) {
    # тема уже применялась без учёта старых скриптов — подставляем настоящие исходные значения из их копий
    $script:SeedForce = $true; Seed-Legacy; $script:SeedForce = $false
    foreach ($ini in @($bak.files.Keys)) {
      if (Test-Path -LiteralPath "$ini.zalet-bak") { $bak.files[$ini] = [ordered]@{ existed = $true; copy = "$ini.zalet-bak" } }
      elseif (Test-Path -LiteralPath "$ini.zalet-new") { $bak.files[$ini] = [ordered]@{ existed = $false; copy = $null }; $dirOf = Split-Path $ini -Parent; if ($bak.readonlyDirs -notcontains $dirOf) { $bak.readonlyDirs += $dirOf } }
    }
  }
  $bak['legacyMerged'] = $true
  Save-Bak
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

  Write-Host '• Иконки в навигации Проводника и «Этом компьютере»: Главная, Галерея, Рабочий стол, Документы, Загрузки, Изображения, Музыка, Видео'
  $cls = 'Software\Classes\CLSID'
  $nav = [ordered]@{
    '{f874310e-b6b7-47dc-bc84-b9e6b38f5903}' = 'zalet-home'             # Главная
    '{e88865ea-0e1c-4e20-9aa6-edcd0212c87c}' = 'gallery'   # Галерея
    '{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}' = 'folder-desktop'; '{754AC886-DF64-4CBA-86B5-F7FBF4FBCEF5}' = 'folder-desktop'
    '{d3162b92-9365-467a-956b-92703aca08af}' = 'folder-docs';    '{A8CDFF1C-4878-43be-B5FD-F8091C1C60D0}' = 'folder-docs'
    '{088e3905-0323-4b02-9826-5d99428e115f}' = 'folder-downloads'; '{374DE290-123F-4565-9164-39C4925E467B}' = 'folder-downloads'
    '{24ad3ad4-a569-4530-98e1-ab02f9417aa8}' = 'folder-pictures'; '{3ADD1653-EB32-4cb0-BBD7-DFA0ABB5ACCA}' = 'folder-pictures'
    '{3dfdf296-dbec-4fb4-81d1-6a3438bcf4de}' = 'folder-music';   '{1CF1260C-4DD0-4ebb-811F-33C572699FDE}' = 'folder-music'
    '{f86fa3ab-70d2-4fc7-9c99-fcbf05467f3a}' = 'folder-videos';  '{A0953C92-50DC-43bf-BE83-3742FED03C9C}' = 'folder-videos'
  }
  foreach ($clsid in $nav.Keys) { Set-V "$cls\$clsid\DefaultIcon" '' "$ico\$($nav[$clsid]).ico,0" ExpandString }

  Write-Host '• Иконки локальных дисков'
  foreach ($ld in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue)) {
    $dl = $ld.DeviceID.TrimEnd(':')
    Set-V "Software\Classes\Applications\Explorer.exe\Drives\$dl\DefaultIcon" '' "$ico\drive.ico,0" ExpandString
  }

  Write-Host '• Иконка сетевого диска «Хранилище»'
  foreach ($md in @(Get-CimInstance Win32_MappedLogicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -match '\\SSD$' })) {
    $letter = $md.DeviceID.TrimEnd(':')
    Set-V "Software\Classes\Applications\Explorer.exe\Drives\$letter\DefaultIcon" '' "$ico\drive-net.ico,0" ExpandString
  }
  # для сетевых дисков Проводник берёт значок из MountPoints2\##сервер#папка\DefaultIcon
  $mp = 'Software\Microsoft\Windows\CurrentVersion\Explorer\MountPoints2'
  $mpKey = $HK.OpenSubKey($mp)
  if ($mpKey) {
    foreach ($nm in $mpKey.GetSubKeyNames() | Where-Object { $_ -like '##*#ssd' }) { Set-V "$mp\$nm\DefaultIcon" '' "$ico\drive-net.ico,0" ExpandString }
    $mpKey.Close()
  }

  # «SSD» в панели навигации Проводника — свой пункт со своим значком (у закреплённой сетевой папки значок не меняется)
  $ssd = $null
  try { $ssd = ((New-Object -ComObject Shell.Application).Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}').Items() | Where-Object { $_.Path -match '^\\\\[^\\]+\\ssd$' } | Select-Object -First 1).Path } catch { }
  if (-not $ssd) { $md0 = @(Get-CimInstance Win32_MappedLogicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -match '\\SSD$' }) | Select-Object -First 1; if ($md0) { $ssd = $md0.ProviderName } }
  if ($ssd) {
    Write-Host "• SSD в панели навигации ($ssd)"
    $g = '{5A1E7A11-55D0-4A1E-9D7E-2A5D5D0E5A55}'
    $ck = "Software\Classes\CLSID\$g"
    Set-V $ck '' 'SSD' String
    Set-V $ck 'System.IsPinnedToNameSpaceTree' 1 DWord
    Set-V $ck 'SortOrderIndex' 0x42 DWord
    Set-V "$ck\DefaultIcon" '' "$ico\drive-net.ico,0" ExpandString
    Set-V "$ck\InProcServer32" '' '%SystemRoot%\system32\shell32.dll' ExpandString
    Set-V "$ck\Instance" 'CLSID' '{0E5AAE11-A475-4c5b-AB00-C66DE400274E}' String
    Set-V "$ck\Instance\InitPropertyBag" 'Attributes' 0x11 DWord
    Set-V "$ck\Instance\InitPropertyBag" 'TargetFolderPath' $ssd ExpandString
    Set-V "$ck\ShellFolder" 'FolderValueFlags' 0x28 DWord
    Set-V "$ck\ShellFolder" 'Attributes' (Dw 0x4D 0x00 0x80 0xF0) DWord
    Set-V "Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\$g" '' 'SSD' String
    Set-V 'Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel' $g 1 DWord
    $bak['ssdNav'] = $g; Save-Bak
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
      $v = switch ($e.kind) { 'Binary' { [Convert]::FromBase64String($e.value) } 'DWord' { [BitConverter]::ToInt32([BitConverter]::GetBytes([int64]$e.value), 0) } 'QWord' { [long]$e.value } 'MultiString' { [string[]]$e.value } default { [string]$e.value } }
      $k.SetValue($e.name, $v, $kind)
    } elseif ($k) { $k.DeleteValue($e.name, $false) }
    if ($k) { $k.Close() }
  }
  if ($bak.Contains('ssdNav') -and $bak.ssdNav) {
    foreach ($sk in "Software\Classes\CLSID\$($bak.ssdNav)", "Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\$($bak.ssdNav)") { try { $HK.DeleteSubKeyTree($sk, $false) } catch { } }
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
  foreach ($ini in $bak.files.Keys) { foreach ($m in "$ini.zalet-bak", "$ini.zalet-new") { if (Test-Path -LiteralPath $m) { attrib -h -s "$m"; [IO.File]::Delete($m) } } }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($old in 'backup.json', 'backup2.json', 'backup3.json') { $p = Join-Path $dst $old; if (Test-Path $p) { Move-Item -LiteralPath $p -Destination "$p.restored-$stamp" -Force } }
  Move-Item -LiteralPath $bakFile -Destination ($bakFile + '.restored-' + $stamp) -Force
  Refresh-Shell -Restart
  Write-Host 'Готово: прежняя тема, иконки и курсоры возвращены.' -ForegroundColor Green
}
if (-not $env:ZALET_NOPAUSE) { Read-Host 'Нажми Enter, чтобы закрыть' }
