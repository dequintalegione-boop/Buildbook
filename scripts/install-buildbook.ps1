$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$downloadRoot = Join-Path $env:TEMP ('Buildbook-package-' + [guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $downloadRoot 'buildbook.zip'
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
$archiveUrl = 'https://github.com/dequintalegione-boop/Buildbook/archive/refs/heads/main.zip'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
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

if (-not $installRoot) {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Выберите папку, в которую Buildbook будет установлен. Путь сохранится и не будет запрашиваться при следующих обновлениях.'
  $dialog.ShowNewFolderButton = $true
  $defaultRoot = Join-Path $env:LOCALAPPDATA 'Programs\Buildbook'
  if (Test-Path -LiteralPath $defaultRoot) { $dialog.SelectedPath = $defaultRoot }
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    throw 'Установка отменена: папка не выбрана.'
  }
  $installRoot = [System.IO.Path]::GetFullPath($dialog.SelectedPath)
}

$sourceFull = [System.IO.Path]::GetFullPath($sourceRoot).TrimEnd('\')
$installFull = [System.IO.Path]::GetFullPath($installRoot).TrimEnd('\')
if ($installFull -eq [System.IO.Path]::GetPathRoot($installFull).TrimEnd('\')) {
  throw 'Нельзя устанавливать Buildbook в корень диска.'
}
if ($installFull.StartsWith($sourceFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Папка установки не должна находиться внутри исходной папки проекта.'
}

New-Item -ItemType Directory -Path $installFull -Force | Out-Null
if ($sourceFull -ne $installFull) {
  & robocopy.exe $sourceFull $installFull /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XD '.git' 'node_modules' 'data' /XF '.env' 'local-host.log' '*.tmp' | Out-Null
  $copyExit = $LASTEXITCODE
  if ($copyExit -gt 7) { throw "Не удалось скопировать файлы Buildbook (robocopy: $copyExit)." }
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

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
  Start-Process 'https://nodejs.org/en/download'
  throw 'Node.js 22 LTS или новее не найден. Установите его по открывшейся ссылке и повторно запустите установщик.'
}
$version = & $node.Source -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^(\d+)\.') { throw 'Не удалось определить версию Node.js.' }
if ([int]$Matches[1] -lt 22) {
  Start-Process 'https://nodejs.org/en/download'
  throw "Нужен Node.js 22 LTS или новее. Обнаружена версия $version."
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
Write-Host 'При повторном запуске установщик использует сохранённую папку и не запрашивает её снова.'
Write-Host 'Настройте Telegram через мастер во вкладке Telegram. Автозапуск можно включить там же.'
