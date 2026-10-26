param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cfg=Get-Content -LiteralPath $Config -Raw|ConvertFrom-Json
$octets=([string]$cfg.bind).Split('.')
if($octets.Count -ne 4 -or $octets[0] -ne '100' -or [int]$octets[1] -lt 64 -or [int]$octets[1] -gt 127 -or ([string]$cfg.token).Length -lt 32){throw 'Private Tailscale address and token required'}
function Token-Valid([string]$Value){
 $expected='Bearer '+$cfg.token
 if($Value.Length -ne $expected.Length){return $false}
 $difference=0;for($i=0;$i -lt $expected.Length;$i++){$difference=$difference -bor ([int][char]$Value[$i] -bxor [int][char]$expected[$i])}
 return $difference -eq 0
}
function Read-JsonScript([string]$Name){
 $script=[IO.File]::ReadAllText((Join-Path $PSScriptRoot $Name),[Text.Encoding]::UTF8)
 $output=@(& ([scriptblock]::Create($script))) -join "`n"
 $i=$output.IndexOf('<<<TMU>>>');if($i -lt 0){throw 'Missing telemetry marker'}
 return ($output.Substring($i+9).Trim()|ConvertFrom-Json)
}
$listener=New-Object Net.HttpListener
$listener.Prefixes.Add(('http://'+$cfg.bind+':'+$cfg.port+'/'))
$listener.Start()
$cache=@{};$cacheAt=@{}
try{
 while($listener.IsListening){
  $context=$listener.GetContext()
  try{
   $status=200;$request=$context.Request
   if(!(Token-Valid ([string]$request.Headers['Authorization']))){$status=401;$body='{"error":"unauthorized"}'}
   elseif($request.HttpMethod -ne 'GET'){$status=405;$body='{"error":"read-only"}'}
   elseif($request.Url.AbsolutePath -eq '/v1/health'){$body='{"version":"1.0.0","readOnly":true}'}
   elseif($request.Url.AbsolutePath -in @('/v1/snapshot','/v1/processes')){
    $key=$request.Url.AbsolutePath
    if(!$cacheAt.ContainsKey($key) -or ((Get-Date)-$cacheAt[$key]).TotalSeconds -gt 4){
     $file=if($key -eq '/v1/processes'){'collect-procs.ps1'}else{'collect-main.ps1'}
     $snap=Read-JsonScript $file
     if(!$snap.sys -or !$snap.mem -or !$snap.cores){throw 'Invalid CPU/memory snapshot'}
     $gpu=$null;$sensors=@()
     try{$gpu=Read-JsonScript 'collect-gpu.ps1'}catch{}
     try{$sensors=@(Invoke-RestMethod http://127.0.0.1:8086/ -TimeoutSec 5)}catch{}
     $cache[$key]=ConvertTo-Json -Compress -Depth 6 -InputObject @{snap=$snap;gpu=$gpu;sensors=$sensors;sampledAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
     $cacheAt[$key]=Get-Date
    }
    $body=$cache[$key]
   }else{$status=404;$body='{"error":"not found"}'}
  }catch{$status=503;$body='{"error":"telemetry unavailable"}'}
  try{
   $bytes=[Text.Encoding]::UTF8.GetBytes($body)
   $context.Response.StatusCode=$status;$context.Response.ContentType='application/json; charset=utf-8'
   $context.Response.Headers['Cache-Control']='no-store';$context.Response.ContentLength64=$bytes.Length
   $context.Response.OutputStream.Write($bytes,0,$bytes.Length)
  }catch{}finally{$context.Response.Close()}
 }
}finally{$listener.Close()}
