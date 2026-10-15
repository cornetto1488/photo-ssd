# Локальный помощник обоев ZALET: слушает только 127.0.0.1:18765 и открывает папки через open.vbs (те же проверки путей).
$ErrorActionPreference = 'SilentlyContinue'
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\ZaletOpenerListener', [ref]$created)
if (-not $created) { exit }
$vbs = Join-Path $PSScriptRoot 'open.vbs'
$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 18765)
$l.Start()
while ($true) {
  $c = $l.AcceptTcpClient()
  try {
    $c.ReceiveTimeout = 3000
    $s = $c.GetStream()
    $buf = New-Object byte[] 4096
    $n = $s.Read($buf, 0, 4096)
    $req = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
    try { $first = ($req -split "`r?`n")[0]; $org = (($req -split "`r?`n") | Where-Object { $_ -match '^(Origin|Referer):' }) -join ' '; Add-Content -Path (Join-Path $PSScriptRoot 'listener.log') -Value ((Get-Date -Format 's') + ' ' + $first.Substring(0,[Math]::Min(60,$first.Length)) + ' | ' + $org) } catch {}
    if ($req -match '^GET /open\?p=([A-Za-z0-9_-]{1,1500})[ &]') {
      Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"'), ('"zaletopen://open/?p=' + $Matches[1] + '"') -WindowStyle Hidden
      $st = '204 No Content'
    } else { $st = '404 Not Found' }
    $r = "HTTP/1.1 $st`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`nContent-Length: 0`r`n`r`n"
    $b = [Text.Encoding]::ASCII.GetBytes($r)
    $s.Write($b, 0, $b.Length)
  } catch {} finally { $c.Close() }
}