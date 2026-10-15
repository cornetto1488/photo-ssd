Remove-Item -Recurse -Force -Path 'HKCU:\Software\Classes\zaletopen' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force -Path (Join-Path $env:LOCALAPPDATA 'ZALET') -ErrorAction SilentlyContinue
Write-Host 'Кнопки папок удалены.' -ForegroundColor Green
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ZaletOpener' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*listener.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
