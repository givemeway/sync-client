
# scripts/register-service.ps1

$ServiceName = "SyncClientService"
$DisplayName = "Sync Client Service"
$Description = "Background synchronization client for syncing files to cloud."
$NodePath = (Get-Command node).Source
$ScriptPath = Join-Path $PSScriptRoot "..\dist\main.js"
$WorkDir = Join-Path $PSScriptRoot ".."

# Check if running as Admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Warning "You must run this script as Administrator!"
    exit 1
}

# Load environment variables just to verify, but we can't easily inject them into the service registry without wrappers.
# However, Node will load .env from the WorkingDirectory.
# We just need to ensure the service runs with the correct WorkingDirectory.
# Native Windows Service controller doesn't easily support "WorkingDirectory" for Node unless we wrapper it.
# BUT, we can use a shim or passing arguments.
# A common trick is to run: "cmd /c cd /d <WorkDir> && node dist/main.js"

$BinPath = "cmd /c cd /d `"$WorkDir`" && `"$NodePath`" `"$ScriptPath`""

Write-Host "Registering Service..."
Write-Host "Binary Path: $BinPath"

# Create Service
# We use New-Service for simpler syntax, or sc.exe for more control. New-Service is cleaner.
# Note: BinPath requires careful quoting.
New-Service -Name $ServiceName -DisplayName $DisplayName -BinaryPathName $BinPath -Description $Description -StartupType Automatic

Write-Host "✅ Service '$ServiceName' registered successfully."
Write-Host "You can start it with: Start-Service $ServiceName"
