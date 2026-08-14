# Google Meet Attendance - Windows Installer
# Downloads all extension files from the GitHub repo into a local
# "meet-attendance" folder, ready to load unpacked in Chrome.
$ErrorActionPreference = 'Stop'

$zip  = Join-Path $env:TEMP 'meet-attendance.zip'
$dest = Join-Path (Get-Location) 'meet-attendance'

Write-Host '== Google Meet Attendance Installer =='
Write-Host 'Downloading files from GitHub...'
Invoke-WebRequest -Uri 'https://github.com/AkshayPant-19/meet-attendance/archive/refs/heads/main.zip' -OutFile $zip

Write-Host 'Extracting...'
$tmp = Join-Path $env:TEMP ('meet-attendance-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zip -DestinationPath $tmp

if (Test-Path -LiteralPath $dest) {
    Write-Host "Removing existing folder: $dest"
    Remove-Item -LiteralPath $dest -Recurse -Force
}

$src = Join-Path $tmp 'meet-attendance-main'
if (-not (Test-Path -LiteralPath $src)) {
    $src = (Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName
}
Move-Item -LiteralPath $src -Destination $dest

Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Installed to: $dest"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. In Chrome open:  chrome://extensions'
Write-Host "  2. Turn ON 'Developer mode' (top-right)"
Write-Host "  3. Click 'Load unpacked'"
Write-Host "  4. Select the folder:"
Write-Host "     $dest"