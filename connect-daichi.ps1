$ErrorActionPreference = 'Stop'
# Записывает логин и пароль Daichi на роутер (/etc/photossd-daichi.json, права 600). Пароль вводится здесь и никуда больше не уходит.
try {
  $email = Read-Host 'Email аккаунта Daichi'
  $sec = Read-Host 'Пароль Daichi (символы не показываются)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $pass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $json = (@{ email = $email; password = $pass } | ConvertTo-Json -Compress)
  $key = Join-Path $HOME '.ssh\openwrt_claude'
  $json | & ssh.exe -i $key -o StrictHostKeyChecking=accept-new root@192.168.1.1 "umask 077; cat > /etc/photossd-daichi.json"
  if ($LASTEXITCODE -eq 0) { Write-Host 'Готово. Данные сохранены на роутере. Напиши в чат: готово.' -ForegroundColor Green }
  else { Write-Host ('Не получилось записать файл на роутер, код ' + $LASTEXITCODE) -ForegroundColor Red }
} catch { Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red }
Read-Host 'Нажми Enter, чтобы закрыть'