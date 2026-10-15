# Локальный помощник обоев ZALET: слушает только 127.0.0.1:18765 и открывает папки через open.vbs (те же проверки путей).
# Не падает от единичных ошибок; если порт занят — ждёт и пробует снова.
$ErrorActionPreference = 'SilentlyContinue'
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\ZaletOpenerListener', [ref]$created)
if (-not $created) { exit }
$vbs = Join-Path $PSScriptRoot 'open.vbs'
$logFile = Join-Path $PSScriptRoot 'listener.log'
function Log($s) { try { if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 200KB) { Set-Content $logFile '' }; Add-Content -Path $logFile -Value ((Get-Date -Format 's') + ' ' + $s) } catch { } }
$l = $null
for ($i = 0; $i -lt 60 -and -not $l; $i++) {
  try { $t = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 18765); $t.Start(); $l = $t } catch { Start-Sleep -Seconds 5 }
}
if (-not $l) { Log 'порт 18765 занят — помощник не запущен'; exit }
Log 'запущен'
while ($true) {
  $c = $null
  try {
    $c = $l.AcceptTcpClient()
    $c.ReceiveTimeout = 3000
    $s = $c.GetStream()
    $buf = New-Object byte[] 4096
    $n = $s.Read($buf, 0, 4096)
    $req = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
    $first = ($req -split "`r?`n")[0]
    if ($req -match '^GET /open\?p=([A-Za-z0-9_-]{1,1500})[ &]') {
      Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"'), ('"zaletopen://open/?p=' + $Matches[1] + '"') -WindowStyle Hidden
      $st = '204 No Content'; Log $first.Substring(0, [Math]::Min(60, $first.Length))
    } else { $st = '404 Not Found' }
    $r = "HTTP/1.1 $st`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`nContent-Length: 0`r`n`r`n"
    $b = [Text.Encoding]::ASCII.GetBytes($r)
    $s.Write($b, 0, $b.Length)
  } catch { Start-Sleep -Milliseconds 200 } finally { if ($c) { try { $c.Close() } catch { } } }
}
