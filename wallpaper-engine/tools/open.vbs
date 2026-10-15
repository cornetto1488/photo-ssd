' Запускает open.ps1 без мигающего окна. Вызывается Windows по ссылке zaletopen:
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count > 0 Then
  u = Replace(WScript.Arguments(0), """", "")
  ps = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\ZALET\open.ps1"
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps & """ """ & u & """", 0, False
End If
