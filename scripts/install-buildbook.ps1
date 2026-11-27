$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$downloadRoot = Join-Path $env:TEMP ('Buildbook-package-' + [guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $downloadRoot 'buildbook.zip'
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
$commitUrl = 'https://api.github.com/repos/dequintalegione-boop/Buildbook/commits/main'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  $commitInfo = Invoke-RestMethod -Uri $commitUrl -Headers @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'Buildbook-Windows-Installer' } -TimeoutSec 30
  $commitSha = [string]$commitInfo.sha
  if ($commitSha -notmatch '^[a-fA-F0-9]{40}$') { throw 'GitHub returned an invalid commit SHA.' }
  $archiveUrl = 'https://github.com/dequintalegione-boop/Buildbook/archive/' + $commitSha + '.zip'
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing -TimeoutSec 120
  Expand-Archive -LiteralPath $archivePath -DestinationPath $downloadRoot -Force
} catch {
  Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
  throw 'Не удалось скачать установочный пакет Buildbook с GitHub. Проверьте подключение к интернету и повторите попытку.'
}
$sourceDirectory = Get-ChildItem -LiteralPath $downloadRoot -Directory | Select-Object -First 1
if (-not $sourceDirectory) {
  Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
  throw 'Архив Buildbook не содержит папку приложения.'
}
$sourceRoot = $sourceDirectory.FullName
$settingsDir = Join-Path $env:LOCALAPPDATA 'Buildbook'
$settingsPath = Join-Path $settingsDir 'install-path.json'
$installRoot = $null

if (Test-Path -LiteralPath $settingsPath) {
  try {
    $saved = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ($saved.version -eq 1 -and [string]$saved.installPath -and (Test-Path -LiteralPath ([string]$saved.installPath) -PathType Container)) {
      $installRoot = [System.IO.Path]::GetFullPath([string]$saved.installPath)
    }
  } catch {
    Write-Warning 'Сохранённый путь установки повреждён. Потребуется выбрать папку заново.'
  }
}

# Ask for the destination on every run. The previously used parent folder is
# preselected for convenience, but the user can choose another location.
$previousInstallRoot = $installRoot
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Каждый запуск установщика требует подтвердить папку. Выберите папку, внутри которой будет создана папка Buildbook, либо выберите саму существующую папку Buildbook. Например: D:\Apps → D:\Apps\Buildbook.'
$dialog.ShowNewFolderButton = $true
$defaultRoot = Join-Path $env:LOCALAPPDATA 'Programs'
if ($previousInstallRoot) {
  $previousParent = Split-Path -Parent $previousInstallRoot
  if ($previousParent -and (Test-Path -LiteralPath $previousParent -PathType Container)) {
    $defaultRoot = $previousParent
  }
}
New-Item -ItemType Directory -Path $defaultRoot -Force | Out-Null
$dialog.SelectedPath = $defaultRoot
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
  throw 'Установка отменена: папка не выбрана.'
}
$selectedRoot = [System.IO.Path]::GetFullPath($dialog.SelectedPath)
# Selecting a folder named Buildbook means it is the exact destination;
# otherwise create/use a dedicated Buildbook subfolder.
if ([System.IO.Path]::GetFileName($selectedRoot.TrimEnd('\\')) -ieq 'Buildbook') {
  $installRoot = $selectedRoot
} else {
  $installRoot = Join-Path $selectedRoot 'Buildbook'
}

$sourceFull = [System.IO.Path]::GetFullPath($sourceRoot).TrimEnd('\')
$installFull = [System.IO.Path]::GetFullPath($installRoot).TrimEnd('\')
if ($installFull -eq [System.IO.Path]::GetPathRoot($installFull).TrimEnd('\')) {
  throw 'Нельзя устанавливать Buildbook в корень диска.'
}
if ($installFull.StartsWith($sourceFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Папка установки не должна находиться внутри исходной папки проекта.'
}

$existingHost = $false
$probe = New-Object System.Net.Sockets.TcpClient
try {
  $connect = $probe.BeginConnect('127.0.0.1', 43127, $null, $null)
  if ($connect.AsyncWaitHandle.WaitOne(500)) {
    $probe.EndConnect($connect)
    $existingHost = $true
  }
} catch {
  $existingHost = $false
} finally {
  $probe.Close()
}
if ($existingHost) {
  Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
  throw 'Сначала остановите уже работающий локальный хост Buildbook, затем повторно запустите установщик. Это предотвращает копирование поверх активной версии.'
}


New-Item -ItemType Directory -Path $installFull -Force | Out-Null
if ($sourceFull -ne $installFull) {
  & robocopy.exe $sourceFull $installFull /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XD '.git' 'node_modules' 'data' /XF '.env' 'local-host.log' '*.tmp' | Out-Null
  $copyExit = $LASTEXITCODE
  if ($copyExit -gt 7) { throw "Не удалось скопировать файлы Buildbook (robocopy: $copyExit)." }
}
# If the destination changed, preserve the existing local host configuration
# without overwriting an already configured destination. Profile data is stored
# separately under LOCALAPPDATA and is not copied or replaced here.
if ($previousInstallRoot -and
    ([System.IO.Path]::GetFullPath($previousInstallRoot).TrimEnd('\\') -ne $installFull) -and
    (Test-Path -LiteralPath (Join-Path $previousInstallRoot '.env') -PathType Leaf) -and
    -not (Test-Path -LiteralPath (Join-Path $installFull '.env'))) {
  Copy-Item -LiteralPath (Join-Path $previousInstallRoot '.env') -Destination (Join-Path $installFull '.env')
}

# Record the exact trusted source commit so the in-app updater can compare
# this installation with the repository's current main commit.
$installMetadataPath = Join-Path $installFull 'buildbook-install.json'
$tempMetadataPath = $installMetadataPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
try {
  $installMetadata = @{
    schemaVersion = 1
    repository = 'dequintalegione-boop/Buildbook'
    branch = 'main'
    commit = $commitSha.ToLowerInvariant()
    installedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($tempMetadataPath, $installMetadata, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tempMetadataPath -Destination $installMetadataPath -Force
} finally {
  if (Test-Path -LiteralPath $tempMetadataPath) { Remove-Item -LiteralPath $tempMetadataPath -Force }
}

New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
$tempSettings = $settingsPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
try {
  $payload = @{ version = 1; installPath = $installFull; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
  [System.IO.File]::WriteAllText($tempSettings, $payload, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tempSettings -Destination $settingsPath -Force
} finally {
  if (Test-Path -LiteralPath $tempSettings) { Remove-Item -LiteralPath $tempSettings -Force }
}

function Get-BuildbookNode {
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($node) { return $node }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $env:Path = (Split-Path -Parent $candidate) + ';' + $env:Path
      return Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    }
  }
  return $null
}
function Get-BuildbookNodeVersion($nodeCommand) {
  if (-not $nodeCommand) { return $null }
  $output = & $nodeCommand.Source -p 'process.versions.node'
  if ($LASTEXITCODE -ne 0 -or [string]$output -notmatch '^(\d+)\.') { return $null }
  return [string]$output
}

$node = Get-BuildbookNode
$version = Get-BuildbookNodeVersion $node
$nodeReady = $false
if ($version -and $version -match '^(\d+)\.' -and [int]$Matches[1] -ge 22) { $nodeReady = $true }

if (-not $nodeReady) {
  Add-Type -AssemblyName System.Windows.Forms
  $reason = if (-not $version) { 'Node.js 22 LTS или новее не найден.' } else { "Обнаружена версия Node.js $version, требуется 22 LTS или новее." }
  $message = $reason + [Environment]::NewLine + [Environment]::NewLine + 'Разрешить Windows Package Manager (winget) установить или обновить Node.js LTS? Установка может запросить стандартное подтверждение Windows.'
  $choice = [System.Windows.Forms.MessageBox]::Show(
    $message,
    'Buildbook — установка компонента',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($winget) {
      if ($node) {
        & $winget.Source upgrade --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements
      } else {
        & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements
      }
      $wingetExit = $LASTEXITCODE

      # A newly installed Node.js may not yet be present in this PowerShell
      # process PATH. Refresh environment paths and check standard install roots.
      $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      $env:Path = @($machinePath, $userPath, $env:Path) -join ';'
      $node = Get-BuildbookNode
      $version = Get-BuildbookNodeVersion $node
      if ($version -and $version -match '^(\d+)\.' -and [int]$Matches[1] -ge 22) {
        $nodeReady = $true
      } elseif ($wingetExit -ne 0) {
        Write-Warning "winget завершился с кодом $wingetExit. Можно установить Node.js вручную."
      }
    } else {
      Write-Warning 'Windows Package Manager (winget) не найден. Откроется официальный сайт Node.js.'
    }
  }

  if (-not $nodeReady) {
    Start-Process 'https://nodejs.org/en/download'
    throw 'Для запуска Buildbook нужен Node.js 22 LTS или новее. Установите его по открывшейся официальной ссылке и повторно запустите установщик.'
  }
}


$startScript = Join-Path $installFull 'scripts\start-buildbook-local-host.ps1'
if (-not (Test-Path -LiteralPath $startScript)) { throw 'В выбранной папке не найден штатный скрипт запуска Buildbook.' }
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScript + '"'
Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $installFull -WindowStyle Hidden

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-WebRequest -Uri 'http://127.0.0.1:43127/' -UseBasicParsing -TimeoutSec 2
    if ($health.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
}
if (-not $ready) {
  Write-Warning 'Локальный хост пока не подтвердил запуск. Проверьте файл data\local-host.log в папке установки.'
  Write-Host "Папка установки сохранена: $installFull"
  exit 2
}

Start-Process 'http://127.0.0.1:43127/'
Remove-Item -LiteralPath $downloadRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Buildbook установлен и локальный хост запущен.'
Write-Host "Папка установки: $installFull"
Write-Host "Сохранённый путь: $settingsPath"
Write-Host 'При каждом запуске установщик повторно спрашивает папку; ранее выбранное расположение предлагается по умолчанию.'
Write-Host 'Настройте Telegram через мастер во вкладке Telegram. Автозапуск можно включить там же.'
