param([Parameter(Mandatory=$true)][string]$Config,[Parameter(Mandatory=$true)][string]$GatewayIP)
# Run deliberately on the Windows host after it is available. Does not reboot or install a driver.
$ErrorActionPreference='Stop'
$cfg=Get-Content -LiteralPath $Config -Raw|ConvertFrom-Json
$script=Join-Path $PSScriptRoot 'exporter.ps1'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$script+'" -Config "'+$Config+'"') -WorkingDirectory $PSScriptRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if(Get-ScheduledTask -TaskName TMU-MobileExporter -ErrorAction SilentlyContinue){throw 'Existing TMU-MobileExporter: review before replacing'}
Register-ScheduledTask -TaskName TMU-MobileExporter -Action $action -Trigger $trigger -Principal $principal -Settings $settings|Out-Null
New-NetFirewallRule -DisplayName 'TMU Mobile read-only from N100' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $cfg.bind -LocalPort $cfg.port -RemoteAddress $GatewayIP -Profile Any|Out-Null
Start-ScheduledTask -TaskName TMU-MobileExporter
Write-Output 'TMU-MobileExporter installed; original sensor task was not modified.'
