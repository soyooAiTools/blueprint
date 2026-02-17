# Launch Unity + auto-dismiss admin warning
# 1. Kill existing Unity
Stop-Process -Name Unity -Force -ErrorAction SilentlyContinue
Stop-Process -Name UnityCrashHandler64 -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 2. Clean old log
Remove-Item 'C:\worker\unity-gui.log' -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\worker\auto-dismiss.log' -Force -ErrorAction SilentlyContinue

# 3. Start auto-dismiss watcher in background
Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\worker\auto-dismiss-unity.ps1') -WindowStyle Hidden

# 4. Start Unity with proper argument passing
$unityExe = 'C:\Program Files\Unity\Hub\Editor\2022.3.14f1\Editor\Unity.exe'
$args = @(
    '-projectPath', 'D:\work\test-luna\Client',
    '-ignoreCompilerErrors',
    '-logFile', 'C:\worker\unity-gui.log'
)
Start-Process -FilePath $unityExe -ArgumentList $args

Write-Output "Unity + auto-dismiss launched"
