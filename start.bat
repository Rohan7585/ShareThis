@echo off
setlocal

rem Starts the ShareThis server. Usage: start.bat [port]   (default 8765)

cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8765"

where java >nul 2>nul
if errorlevel 1 (
    echo Java was not found on PATH. Install Java 17 or newer.
    goto fail
)
where mvn >nul 2>nul
if errorlevel 1 (
    echo Maven was not found on PATH. Install Maven and add its bin folder to PATH.
    goto fail
)

netstat -ano -p TCP | findstr /R /C:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo Port %PORT% is already in use. Stop the other program or pick another port, e.g.:
    echo     start.bat 9000
    goto fail
)

echo ============================================================
echo  Starting ShareThis on port %PORT%. Press Ctrl+C to stop.
echo.
echo  On this computer:
echo     http://localhost:%PORT%
echo.
echo  On other devices on the same network:
rem Prefer adapters with a default gateway (the Wi-Fi/Ethernet you're connected to); if none,
rem fall back to any private IPv4 address on a non-virtual adapter (e.g. an offline hotspot).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ips = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { $_.IPv4Address.IPAddress });" ^
  "if (-not $ips) { $ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp','Manual' -and $_.InterfaceAlias -notmatch 'virtual|vethernet|hyper-v|vmware|vbox|docker|wsl|loopback|vpn' } | ForEach-Object { $_.IPAddress }) }" ^
  "if ($ips) { $ips | Sort-Object -Unique | ForEach-Object { '    http://' + $_ + ':%PORT%' } } else { '    (no network address found - is Wi-Fi connected?)' }"
echo ============================================================
echo.
call mvn -q spring-boot:run "-Dspring-boot.run.arguments=--server.port=%PORT%"
if errorlevel 1 goto fail
exit /b 0

:fail
echo.
pause
exit /b 1
