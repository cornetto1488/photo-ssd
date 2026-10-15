Remove-Item -Recurse -Force -Path 'HKCU:\Software\Classes\zaletopen' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force -Path (Join-Path $env:LOCALAPPDATA 'ZALET') -ErrorAction SilentlyContinue
Write-Host 'Кнопки папок удалены.' -ForegroundColor Green
