$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startupScript = Join-Path $root 'scripts\start-buildbook-local-host.ps1'
$installScript = Join-Path $root 'scripts\install-buildbook-autostart.ps1'
$uninstallScript = Join-Path $root 'scripts\uninstall-buildbook-autostart.ps1'
$taskName = 'Buildbook Local Host'
$launcher = $null
$nodeProcessId = $null

foreach ($path in @($startupScript, $installScript, $uninstallScript)) {
  $tokens = $null
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -gt 0) {
    throw "PowerShell syntax validation failed for \${path}: $($parseErrors[0].Message)"
  }
}

try {
  $stdout = Join-Path $env:RUNNER_TEMP 'buildbook-host-stdout.log'
  $stderr = Join-Path $env:RUNNER_TEMP 'buildbook-host-stderr.log'
  $launcher = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startupScript
  ) -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  $deadline = (Get-Date).AddSeconds(40)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    $node = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains('host\run-buildbook-local-host.mjs') -and $_.CommandLine.Contains($root) } |
      Select-Object -First 1
    if ($node) {
      $nodeProcessId = [int]$node.ProcessId
      try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:43127/' -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200 -and $response.Content.Contains('<html')) {
          $ready = $true
          break
        }
      } catch {
        # The host may still be binding its loopback listener.
      }
    }
    if ($launcher.HasExited) {
      $outText = if (Test-Path $stdout) { Get-Content $stdout -Raw } else { '' }
      $errText = if (Test-Path $stderr) { Get-Content $stderr -Raw } else { '' }
      throw "Local host launcher exited early. stdout=$outText stderr=$errText"
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready -or -not $nodeProcessId) {
    throw 'Windows local host did not become ready on 127.0.0.1:43127 within 40 seconds.'
  }

  $envFile = Join-Path $root '.env'
  $envText = Get-Content -LiteralPath $envFile -Raw
  if ($envText -notmatch '(?m)^BUILDBOOK_LOCAL_API_TOKEN=[0-9a-f]{64}$') {
    throw 'The first-run script did not generate a 64-character hexadecimal API secret.'
  }

  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl = Get-Acl -LiteralPath $envFile
  $unexpectedEntries = @($acl.Access | Where-Object { $_.IdentityReference.Value -ne $currentIdentity })
  $currentEntry = @($acl.Access | Where-Object {
    $_.IdentityReference.Value -eq $currentIdentity -and
    (($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
  })
  if ($unexpectedEntries.Count -gt 0 -or $currentEntry.Count -eq 0) {
    throw 'The .env ACL is not restricted to the current Windows account with FullControl.'
  }
}
finally {
  if ($nodeProcessId) {
    Stop-Process -Id $nodeProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($launcher -and -not $launcher.HasExited) {
    Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
  }
}

# Exercise the real Task Scheduler registration path without starting a second
# host instance. The task is removed in finally so the hosted runner stays clean.
try {
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installScript -NoStart
  if ($LASTEXITCODE -ne 0) {
    throw 'The Windows auto-start installer returned a non-zero exit code.'
  }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if ([int]$task.Settings.RestartCount -ne 5) {
    throw 'The scheduled task does not have the expected five restart attempts.'
  }
  if ([string]$task.Principal.RunLevel -ne 'Limited') {
    throw 'The scheduled task is not configured with the Limited run level.'
  }
  $action = @($task.Actions) | Select-Object -First 1
  if (-not $action.Arguments.Contains($startupScript)) {
    throw 'The scheduled task does not point to the fixed Buildbook startup script.'
  }
}
finally {
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $uninstallScript
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}

Write-Host 'Windows local-host smoke test passed: PowerShell syntax, first-run startup, loopback HTTP, generated secret, .env ACL, and Task Scheduler registration.'
