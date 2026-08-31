# register-scheduled-tasks.ps1
# Registers two Windows scheduled tasks that run run-auto-announcements.bat:
#   - "NEPSE-Announcements-Morning" — every 30 min, 7:00 AM through 10:30 AM
#   - "NEPSE-Announcements-Evening" — every 30 min, 4:00 PM through 8:30 PM
#
# Run ONCE as Administrator from a PowerShell prompt:
#   cd C:\Users\ACER\OneDrive\Desktop\news-tools
#   powershell -ExecutionPolicy Bypass -File .\register-scheduled-tasks.ps1
#
# To remove later:
#   Unregister-ScheduledTask -TaskName "NEPSE-Announcements-Morning" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "NEPSE-Announcements-Evening" -Confirm:$false
#
# Mixed-approach reasoning:
#   - Native PowerShell cmdlets (Get-ScheduledTask / Unregister-ScheduledTask)
#     for the "does it exist? remove it first" step — they respect
#     -ErrorAction SilentlyContinue, so a missing task on first run doesn't
#     trigger a NativeCommandError under $ErrorActionPreference = "Stop".
#   - schtasks.exe for the /Create step — because New-ScheduledTaskTrigger
#     -Daily returns a trigger whose .Repetition sub-properties aren't
#     settable on some Windows 10/11 builds (you get "The property
#     'Interval' cannot be found on this object").

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BatPath = Join-Path $ScriptDir "run-auto-announcements.bat"

if (-not (Test-Path $BatPath)) {
  throw "Cannot find run-auto-announcements.bat at $BatPath. Run this script from inside the news-tools directory."
}

Write-Host "Using script: $BatPath" -ForegroundColor Cyan
Write-Host "Running as:   $env:USERDOMAIN\$env:USERNAME" -ForegroundColor Cyan
Write-Host ""

# schtasks /TR needs the path wrapped in escaped quotes so directories
# with spaces (like OneDrive) work correctly.
$trArg = "`"$BatPath`""
$runAs = "$env:USERDOMAIN\$env:USERNAME"

$tasks = @(
  @{
    Name        = "NEPSE-Announcements-Morning"
    Description = "Fetch+post new ShareSansar announcements (every 30 min, 7-10:30 AM NPT)"
    StartTime   = "07:00"
    Duration    = "0003:30"  # 3h 30m (covers 07:00 through 10:30)
  },
  @{
    Name        = "NEPSE-Announcements-Evening"
    Description = "Fetch+post new ShareSansar announcements (every 30 min, 4-8:30 PM NPT)"
    StartTime   = "16:00"
    Duration    = "0004:30"  # 4h 30m (covers 16:00 through 20:30)
  }
)

foreach ($task in $tasks) {
  # Remove any existing version first (idempotent re-runs). Native
  # PowerShell handles "doesn't exist" cleanly via -ErrorAction.
  $existing = Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Removing existing task: $($task.Name)" -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $task.Name -Confirm:$false
  }

  Write-Host "Registering: $($task.Name)" -ForegroundColor Cyan
  Write-Host "  Start: $($task.StartTime) daily, repeat every 30 min for $($task.Duration)"

  # schtasks /Create flags:
  #   /SC DAILY        — daily recurrence
  #   /ST <time>       — first run of the day
  #   /RI 30           — repeat every 30 minutes
  #   /DU <HHHH:MM>    — repetition window length
  #   /RU <user>       — run as the current Windows user
  #   /IT              — interactive: only fires when user is logged on
  #                       (so no /RP password prompt needed)
  #   /F               — force overwrite if task exists
  & schtasks /Create `
    /TN $task.Name `
    /TR $trArg `
    /SC DAILY `
    /ST $task.StartTime `
    /RI 30 `
    /DU $task.Duration `
    /RU $runAs `
    /IT `
    /F | Out-Null

  if ($LASTEXITCODE -ne 0) {
    throw "schtasks /Create failed for $($task.Name) (exit $LASTEXITCODE)"
  }

  # Update description (schtasks /Create has no description flag in some
  # Windows versions — set it via Set-ScheduledTask after creation).
  try {
    Set-ScheduledTask -TaskName $task.Name -Description $task.Description | Out-Null
  } catch {
    # Non-fatal — description is cosmetic.
    Write-Host "  (note: couldn't set Description: $($_.Exception.Message))" -ForegroundColor DarkGray
  }

  Write-Host "  Registered." -ForegroundColor Green
  Write-Host ""
}

Write-Host "Done. Both tasks registered." -ForegroundColor Green
Write-Host ""
Write-Host "Verify with:" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTask -TaskName 'NEPSE-Announcements-*' | Format-Table TaskName, State"
Write-Host ""
Write-Host "Or with schtasks:" -ForegroundColor Cyan
Write-Host "  schtasks /Query /TN 'NEPSE-Announcements-Morning' /V /FO LIST"
Write-Host ""
Write-Host "Run on demand (without waiting for cron) with:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName 'NEPSE-Announcements-Evening'"
Write-Host ""
Write-Host "View Task Scheduler GUI:" -ForegroundColor Cyan
Write-Host "  taskschd.msc  ->  Task Scheduler Library  ->  NEPSE-Announcements-*"
Write-Host ""
Write-Host "Logs are written to:" -ForegroundColor Cyan
Write-Host "  $ScriptDir\logs\auto-YYYY-MM-DD.log"
