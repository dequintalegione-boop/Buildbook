param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-fA-F0-9]{40}$')]
  [string]$CommitSha,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$ParentProcessId,
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$CommitSha = $CommitSha.ToLowerInvariant()
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { throw 'Папка установки Buildbook не найдена.' }
if ($InstallRoot -eq [System.IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\')) { throw 'Обновление запрещено для корня диска.' }

$settingsRoot = Join-Path $env:LOCALAPPDATA 'Buildbook\updates'
New-Item -ItemType Directory -Path $settingsRoot -Force | Out-Null
$logPath = Join-Path $settingsRoot 'update.log'
$lockPath = Join-Path $settingsRoot 'update.lock'
$lockStream = $null
$tempRoot = Join-Path $env:TEMP ('Buildbook-update-' + [guid]::NewGuid().ToString('N'))
$backupRoot = Join-Path $settingsRoot ('backup-' + $CommitSha.Substring(0, 12) + '-' + [guid]::NewGuid().ToString('N'))
$backupCreated = $false
$installStarted = $false
$hostLauncher = $null
$hostPort = 43127
$envPath = Join-Path $InstallRoot '.env'
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
  $envText = Get-Content -LiteralPath $envPath -Raw
  $portMatch = [regex]::Match($envText, '(?m)^BUILDBOOK_LOCAL_API_PORT=(\d+)\s*$')
  if ($portMatch.Success) {
    $candidatePort = [int]$portMatch.Groups[1].Value
    if ($candidatePort -ge 1 -and $candidatePort -le 65535) { $hostPort = $candidatePort }
  }
}

function Write-UpdateLog([string]$Message) {
  Add-Content -LiteralPath $logPath -Value ([DateTime]::UtcNow.ToString('o') + ' ' + $Message) -Encoding UTF8
}
function Invoke-Robocopy([string]$Source, [string]$Destination, [string[]]$ExtraArguments) {
  $arguments = @($Source, $Destination) + $ExtraArguments
  & robocopy.exe @arguments | Out-Null
  $code = $LASTEXITCODE
  if ($code -gt 7) { throw ('Копирование файлов завершилось с кодом robocopy ' + $code + '.') }
}
function Start-BuildbookHost {
  $startupScript = Join-Path $InstallRoot 'scripts\start-buildbook-local-host.ps1'
  if (-not (Test-Path -LiteralPath $startupScript -PathType Leaf)) { throw 'В обновлении отсутствует штатный скрипт запуска Buildbook.' }
  $scriptArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $startupScript)
  $script:hostLauncher = Start-Process -FilePath 'powershell.exe' -ArgumentList $scriptArguments -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru
}
function Wait-BuildbookHost([int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $hostPort + '/') -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200 -and $response.Content.Contains('<html')) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Stop-BuildbookProcesses {
  $expectedRoot = $InstallRoot.TrimEnd('\')
  $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains('host\run-buildbook-local-host.mjs') -and
    $_.CommandLine.IndexOf($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  foreach ($process in $processes) { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue }
  if ($script:hostLauncher -and -not $script:hostLauncher.HasExited) { Stop-Process -Id $script:hostLauncher.Id -Force -ErrorAction SilentlyContinue }
}
function Expand-VerifiedArchive([string]$ArchivePath, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt 20000) { throw 'Архив содержит недопустимое количество файлов.' }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $totalBytes = [int64]0
    $rootName = $null
    foreach ($entry in $archive.Entries) {
      $entryName = $entry.FullName.Replace('\', '/')
      if ([string]::IsNullOrWhiteSpace($entryName) -or $entryName.StartsWith('/') -or $entryName -match '^[a-zA-Z]:') { throw 'Архив содержит небезопасный путь.' }
      $parts = $entryName.Split('/')
      if ($parts.Count -lt 2 -or $parts[0] -notmatch '^Buildbook-[a-fA-F0-9]{7,40}$') { throw 'Неожиданная структура официального архива Buildbook.' }
      if ($null -eq $rootName) { $rootName = $parts[0] }
      if ($parts[0] -cne $rootName) { throw 'Архив содержит несколько корневых папок.' }
      $isDirectory = $entryName.EndsWith('/')
      $relativeParts = @($parts | Select-Object -Skip 1)
      if ($isDirectory -and $relativeParts.Count -gt 0 -and $relativeParts[-1] -eq '') {
        $relativeParts = @($relativeParts | Select-Object -First ($relativeParts.Count - 1))
      }
      if ($relativeParts.Count -eq 0) { continue }
      foreach ($part in $relativeParts) {
        if ([string]::IsNullOrWhiteSpace($part) -or $part -eq '.' -or $part -eq '..' -or
          $part -match '[<>:"|?*\x00-\x1F]' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
          $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Архив содержит недопустимое имя файла.' }
      }
      $relativePath = $relativeParts -join '\'
      if (-not $seen.Add($relativePath)) { throw 'Архив содержит повторяющиеся пути.' }
      $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixType -eq 0xA000) { throw 'Символические ссылки в обновлении запрещены.' }
      $targetPath = [System.IO.Path]::GetFullPath((Join-Path $Destination $relativePath))
      $destinationPrefix = $Destination.TrimEnd('\') + '\'
      if (-not $targetPath.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Путь из архива выходит за пределы временной папки.' }
      if ($isDirectory) {
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        continue
      }
      $totalBytes += [int64]$entry.Length
      if ($entry.Length -gt 100MB -or $totalBytes -gt 800MB) { throw 'Размер распакованного обновления превышает безопасный лимит.' }
      $parent = Split-Path -Parent $targetPath
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
      $inputStream = $entry.Open()
      try {
        $outputStream = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
      } finally { $inputStream.Dispose() }
    }
    if (-not $rootName) { throw 'Не удалось определить корневую папку архива.' }
    return (Join-Path $Destination $rootName)
  } finally { $archive.Dispose() }
}

try {
  try {
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch { throw 'Другое обновление Buildbook уже выполняется.' }

  $markerPath = Join-Path $InstallRoot 'buildbook-install.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'Эта установка не зарегистрирована. Переустановите Buildbook штатным установщиком перед автоматическим обновлением.' }
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.schemaVersion -ne 1 -or $marker.repository -ne 'dequintalegione-boop/Buildbook' -or
    $marker.branch -ne 'main' -or [string]$marker.commit -notmatch '^[a-fA-F0-9]{40}$') {
    throw 'Файл сведений об установке повреждён. Автоматическое обновление отменено.'
  }

  Write-UpdateLog ('Подготовка обновления до ' + $CommitSha + '.')
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $archivePath = Join-Path $tempRoot 'buildbook.zip'
  $archiveUrl = 'https://github.com/dequintalegione-boop/Buildbook/archive/' + $CommitSha + '.zip'
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing -TimeoutSec 180
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf) -or (Get-Item -LiteralPath $archivePath).Length -lt 1024 -or (Get-Item -LiteralPath $archivePath).Length -gt 250MB) {
    throw 'GitHub вернул архив недопустимого размера.'
  }

  $stageRoot = Join-Path $tempRoot 'stage'
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  $sourceRoot = Expand-VerifiedArchive -ArchivePath $archivePath -Destination $stageRoot
  foreach ($requiredPath in @('index.html', 'host\run-buildbook-local-host.mjs', 'scripts\start-buildbook-local-host.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $requiredPath) -PathType Leaf)) { throw ('В архиве отсутствует обязательный файл: ' + $requiredPath) }
  }
  $archiveRootName = Split-Path -Leaf $sourceRoot
  $archiveSha = $archiveRootName.Substring('Buildbook-'.Length)
  if (-not $CommitSha.StartsWith($archiveSha, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Архив GitHub не соответствует запрошенному коммиту.'
  }
  $newMarker = @{
    schemaVersion = 1
    repository = 'dequintalegione-boop/Buildbook'
    branch = 'main'
    commit = $CommitSha
    installedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $sourceRoot 'buildbook-install.json'), $newMarker, (New-Object System.Text.UTF8Encoding($false)))

  $parentDeadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $parentDeadline) {
    if (-not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) { throw 'Локальный хост не завершился вовремя. Файлы приложения не изменялись.' }

  Write-UpdateLog 'Архив проверен. Создаю резервную копию файлов приложения.'
  Invoke-Robocopy -Source $InstallRoot -Destination $backupRoot -ExtraArguments @('/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1', '/XD', '.git', 'node_modules', 'data', 'updates', '/XF', '.env', 'local-host.log', '*.tmp')
  $backupCreated = $true

  Write-UpdateLog 'Устанавливаю подготовленные файлы. .env, data, node_modules и .git исключены из замены.'
  $installStarted = $true
  Invoke-Robocopy -Source $sourceRoot -Destination $InstallRoot -ExtraArguments @('/MIR', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1', '/XD', '.git', 'node_modules', 'data', 'updates', '/XF', '.env', 'local-host.log', '*.tmp')

  $installedMarker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (([string]$installedMarker.commit).ToLowerInvariant() -ne $CommitSha) { throw 'После установки не удалось подтвердить новую версию Buildbook.' }

  Write-UpdateLog 'Файлы установлены. Запускаю обновлённый локальный хост.'
  Start-BuildbookHost
  if (-not (Wait-BuildbookHost -TimeoutSeconds 60)) { throw 'Новая версия не смогла запустить локальный хост за 60 секунд.' }
  Write-UpdateLog ('Обновление успешно завершено: ' + $CommitSha + '. Резервная копия: ' + $backupRoot)
} catch {
  $failure = $_.Exception.Message
  Write-UpdateLog ('ОШИБКА: ' + $failure)
  if ($installStarted -and $backupCreated) {
    try {
      Write-UpdateLog 'Выполняю откат к резервной копии.'
      Stop-BuildbookProcesses
      Invoke-Robocopy -Source $backupRoot -Destination $InstallRoot -ExtraArguments @('/MIR', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1', '/XD', '.git', 'node_modules', 'data', 'updates', '/XF', '.env', 'local-host.log', '*.tmp')
      Start-BuildbookHost
      if (Wait-BuildbookHost -TimeoutSeconds 60) { Write-UpdateLog 'Откат завершён. Предыдущая версия Buildbook снова запущена.' }
      else { Write-UpdateLog 'КРИТИЧЕСКАЯ ОШИБКА: откат выполнен, но предыдущий локальный хост не подтвердил запуск.' }
    } catch { Write-UpdateLog ('КРИТИЧЕСКАЯ ОШИБКА ОТКАТА: ' + $_.Exception.Message) }
  } elseif (-not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) {
    if ($backupCreated) { Write-UpdateLog 'Установка файлов не начиналась; исходные файлы оставлены без изменений.' }
    try {
      Write-UpdateLog 'Возобновляю исходный локальный хост после отменённого обновления.'
      Start-BuildbookHost
      if (Wait-BuildbookHost -TimeoutSeconds 60) { Write-UpdateLog 'Исходная версия Buildbook снова запущена.' }
      else { Write-UpdateLog 'ОШИБКА: исходный локальный хост не подтвердил повторный запуск.' }
    } catch { Write-UpdateLog ('ОШИБКА ПОВТОРНОГО ЗАПУСКА: ' + $_.Exception.Message) }
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(('Не удалось обновить Buildbook.' + [Environment]::NewLine + $failure + [Environment]::NewLine + [Environment]::NewLine + 'Подробности: ' + $logPath), 'Buildbook — ошибка обновления', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  } catch { }
} finally {
  if ($lockStream) { $lockStream.Dispose() }
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
