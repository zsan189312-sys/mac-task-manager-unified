$ErrorActionPreference=0;$ProgressPreference=0
[Console]::OutputEncoding=[Text.Encoding]::UTF8
sal g gcim
$os=g Win32_OperatingSystem;$cs=g Win32_ComputerSystem
g Win32_PerfFormattedData_PerfOS_Processor|Out-Null
sleep -m 500
$pf=g Win32_PerfFormattedData_PerfOS_Processor
$pm=g Win32_PerfFormattedData_PerfOS_Memory
$pd=g Win32_PerfFormattedData_PerfDisk_PhysicalDisk
$pn=g Win32_PerfFormattedData_Tcpip_NetworkInterface
$pp=g Win32_Processor|select -First 1
$fq=@{};g Win32_PerfFormattedData_Counters_ProcessorInformation|?{$_.Name -match '^\d+,\d+$'}|%{$fq[$_.Name]=[double]$_.PercentProcessorPerformance}
$na=Get-NetAdapterStatistics
$ld=g Win32_LogicalDisk -Filter "DriveType=3"
$pfu=g Win32_PageFileUsage
$t=$pf|?{$_.Name -eq '_Total'}
$cl=@($pf|?{$_.Name -ne '_Total'}|sort{[int]$_.Name})
$dt=$pd|?{$_.Name -eq '_Total'}|select -First 1
$procs=@();if(1){$pr=@{};$pw=@{};g Win32_PerfFormattedData_PerfProc_Process|?{$_.Name -ne '_Total'}|%{$b=($_.Name -split '#')[0];if(!$pr.Contains($b)){$pr[$b]=0;$pw[$b]=0};$pr[$b]+=[long]$_.IOReadBytesPersec;$pw[$b]+=[long]$_.IOWriteBytesPersec}
$procs=@(Get-Process|%{$c=0.0;try{$c=[double]$_.TotalProcessorTime.TotalSeconds}catch{};@{pid=$_.Id;name=$_.ProcessName;rss=[long]$_.WorkingSet64;cpuSec=[math]::Round($c,3);ioR=$pr[$_.ProcessName];ioW=$pw[$_.ProcessName]}})}
$disks=@($pd|?{$_.Name -ne '_Total'}|%{@{name=$_.Name;r=[long]$_.DiskReadBytesPersec;w=[long]$_.DiskWriteBytesPersec}})
$volumes=@($ld|%{@{mount=$_.DeviceID;total=[long]$_.Size;free=[long]$_.FreeSpace}})
$net=@($pn|%{$n=$_.Name;$cn=$n -replace '\[R\]','(R)';$a=@($na|?{$_.InterfaceDescription -eq $cn -or $_.Name -eq $n})[0];@{name=$n;rx=[long]$_.BytesReceivedPersec;tx=[long]$_.BytesSentPersec;rxTotal=$(if($a){[long]$a.ReceivedBytes}else{0});txTotal=$(if($a){[long]$a.SentBytes}else{0})}})
$swT=@($pfu|measure AllocatedBaseSize -Sum).Sum;$swU=@($pfu|measure CurrentUsage -Sum).Sum
$up=[long]([DateTimeOffset]::Now.Subtract($os.LastBootUpTime).TotalSeconds)
$o=@{sys=@{hostname=$cs.DNSHostname;os=($os.Caption+' '+$os.Version).Trim();model=($cs.Manufacturer+' '+$cs.Model).Trim();cores=$cs.NumberOfLogicalProcessors;cpuModel=$pp.Name;fmax=[int]$pp.MaxClockSpeed;fcur=[int]$pp.CurrentClockSpeed;perf=$fq};uptime=$up;cpu_total=[int]$t.PercentProcessorTime;cpu_user=[int]$t.PercentUserTime;cpu_sys=[int]$t.PercentPrivilegedTime;cpu_idle=[int]$t.PercentIdleTime;cores=$cl|%{[int]$_.PercentProcessorTime};mem=@{total=[long]($os.TotalVisibleMemorySize*1KB);avail=[long]$pm.AvailableBytes;cached=[long]($pm.StandbyCacheCoreBytes+$pm.StandbyCacheNormalPriorityBytes+$pm.StandbyCacheReserveBytes);commit=[long]$pm.CommittedBytes};swap=@{total=[long]($swT*1MB);used=[long]($swU*1MB)};disk=$disks;disk_total_r=[long]$dt.DiskReadBytesPersec;disk_total_w=[long]$dt.DiskWriteBytesPersec;tps=[int]$dt.DiskTransfersPersec;volumes=$volumes;net=$net;processCount=[int]$os.NumberOfProcesses;procs=$procs}
echo '<<<TMU>>>'
ConvertTo-Json $o -Compress -Depth 4