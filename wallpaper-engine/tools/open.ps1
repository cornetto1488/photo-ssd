param([string]$Url)
# Открывает ПАПКУ в проводнике по ссылке zaletopen://open/?p=<путь в base64>.
# Безопасность: только существующие папки; сетевые — только на роутере; файлы и программы не запускаются.
$ErrorActionPreference = 'SilentlyContinue'
$allowedHosts = @('192.168.1.1')
try {
  $m = [regex]::Match($Url, '[?&]p=([^&#"]+)')
  if (-not $m.Success) { exit }
  $s = [uri]::UnescapeDataString($m.Groups[1].Value).Replace('-', '+').Replace('_', '/')
  switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)).Trim().Trim('"')
  if ($path.Length -lt 4 -or $path.Length -gt 400) { exit }
  if ($path -match '^\\\\([^\\]+)\\') {
    if ($allowedHosts -notcontains $Matches[1]) { exit }
  } elseif ($path -notmatch '^[A-Za-z]:\\') { exit }
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { exit }
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $path + '"')
} catch { }
