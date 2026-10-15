# Устанавливает кнопки папок для обоев ZALET: копирует помощника в %LOCALAPPDATA%\ZALET и
# регистрирует ссылки zaletopen: для текущего пользователя (права администратора не нужны).
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'ZALET'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'open.ps1'), (Join-Path $PSScriptRoot 'open.vbs') -Destination $dir -Force
$k = 'HKCU:\Software\Classes\zaletopen'
New-Item -Force -Path $k | Out-Null
Set-ItemProperty -Path $k -Name '(Default)' -Value 'URL:ZALET Open'
New-ItemProperty -Path $k -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Force -Path "$k\shell\open\command" | Out-Null
Set-ItemProperty -Path "$k\shell\open\command" -Name '(Default)' -Value ('wscript.exe "' + (Join-Path $dir 'open.vbs') + '" "%1"')
Write-Host ''
Write-Host 'Готово! Кнопки папок в обоях ZALET теперь открывают проводник.' -ForegroundColor Green
Write-Host "Помощник лежит в: $dir"
Write-Host 'Чтобы удалить: запусти «Удалить кнопки папок.cmd».'
