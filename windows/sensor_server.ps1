param(
  [ValidateRange(1024,65535)][int]$Port = 8086,
  [string]$LibraryDirectory = (Join-Path $PSScriptRoot 'releases\lhm-0.9.6'),
  [ValidateRange(250,10000)][int]$IntervalMs = 1000
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir "sensor-$Port.log"
function Write-Log([string]$Message) {
  if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) {
    Move-Item -LiteralPath $log -Destination ($log + '.previous') -Force
  }
  Add-Content -LiteralPath $log -Encoding UTF8 -Value ((Get-Date -Format o) + ' ' + $Message)
}
function Read-Hardware($Hardware, $Result) {
  $Hardware.Update()
  foreach ($sensor in $Hardware.Sensors) {
    if ($sensor.SensorType -notin @('Power','Temperature','Load','Clock') -or $null -eq $sensor.Value) { continue }
    $value = [double]$sensor.Value
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { continue }
    [void]$Result.Add([pscustomobject]@{
      hw = [string]$Hardware.HardwareType
      name = $sensor.Name
      type = [string]$sensor.SensorType
      val = [math]::Round($value, 3)
    })
  }
  foreach ($sub in $Hardware.SubHardware) { Read-Hardware $sub $Result }
}
$computer = $null
$listener = $null
try {
  Set-Location -LiteralPath $LibraryDirectory
  Add-Type -Path (Join-Path $LibraryDirectory 'LibreHardwareMonitorLib.dll')
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $LibraryDirectory 'LibreHardwareMonitorLib.dll')).FileVersion
  $computer = New-Object LibreHardwareMonitor.Hardware.Computer
  $computer.IsCpuEnabled = $true
  $computer.IsGpuEnabled = $false
  $computer.Open()
  $listener = New-Object Net.HttpListener
  $listener.Prefixes.Add("http://127.0.0.1:$Port/")
  $listener.Start()
  $startedAt = [DateTime]::UtcNow
  $sampleAt = $null
  $lastError = $null
  $snapshot = @()
  $json = '[]'
  $sampleCount = 0
  $pending = $listener.GetContextAsync()
  Write-Log "started LHM=$version provider=PawnIO endpoint=127.0.0.1:$Port"
  while ($listener.IsListening) {
    # 阻塞等待请求；无人查看时不唤醒、不访问驱动，也不重复序列化 JSON。
    $pending.Wait()
    $context = $pending.Result
    $isRead = $context.Request.HttpMethod -eq 'GET' -and $context.Request.Url.AbsolutePath -in @('/','/health')
    if ($isRead -and (!$sampleAt -or ([DateTime]::UtcNow - $sampleAt).TotalMilliseconds -ge $IntervalMs)) {
      try {
        $items = New-Object 'System.Collections.Generic.List[object]'
        foreach ($hardware in $computer.Hardware) { Read-Hardware $hardware $items }
        $snapshot = @($items.ToArray())
        $json = ConvertTo-Json -InputObject $snapshot -Compress -Depth 4
        $sampleAt = [DateTime]::UtcNow
        $sampleCount++
        $lastError = $null
      } catch {
        $snapshot = @(); $json = '[]'; $sampleAt = $null
        $lastError = $_.Exception.Message
        Write-Log ('sample error: ' + $lastError)
      }
    }
    try {
      $context.Response.ContentType = 'application/json; charset=utf-8'
      $context.Response.Headers['Cache-Control'] = 'no-store'
      if ($context.Request.HttpMethod -ne 'GET') {
        $context.Response.StatusCode = 405
        $body = '{"error":"GET required"}'
      } elseif ($context.Request.Url.AbsolutePath -eq '/health') {
        $cpuTemperature = @($snapshot | Where-Object { $_.hw -eq 'Cpu' -and $_.type -eq 'Temperature' -and $_.val -gt 0 }).Count -gt 0
        $cpuPower = @($snapshot | Where-Object { $_.hw -eq 'Cpu' -and $_.type -eq 'Power' -and $_.name -eq 'Package' -and $_.val -gt 0 }).Count -gt 0
        $body = ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{
          version='2.2.6'; samplingMode='on-demand'; sampleCount=$sampleCount; libraryVersion=$version; provider='PawnIO'; pid=$PID
          startedAt=$startedAt.ToString('o')
          sampleAt=$(if($sampleAt){$sampleAt.ToString('o')}else{$null})
          sampleAgeMs=$(if($sampleAt){[int]([DateTime]::UtcNow-$sampleAt).TotalMilliseconds}else{$null})
          cpuTemperature=$cpuTemperature; cpuPower=$cpuPower; sensorCount=$snapshot.Count
          error=$lastError
        })
      } elseif ($context.Request.Url.AbsolutePath -eq '/') {
        $body = $json
      } else {
        $context.Response.StatusCode = 404
        $body = '{"error":"not found"}'
      }
      $bytes = [Text.Encoding]::UTF8.GetBytes($body)
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes,0,$bytes.Length)
    } catch {
      Write-Log ('response error: ' + $_.Exception.Message)
    } finally {
      $context.Response.Close()
      $pending = $listener.GetContextAsync()
    }
  }
} catch {
  Write-Log ('fatal: ' + $_.Exception.ToString() + ' at ' + $_.ScriptStackTrace)
  exit 1
} finally {
  if ($listener) { $listener.Close() }
  if ($computer) { $computer.Close() }
}
