$ErrorActionPreference='SilentlyContinue'
function cv([string]$x){$v=0.0;if([double]::TryParse($x,[ref]$v)){$v}else{-1}}
$gl=@(nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,power.draw,power.limit,temperature.gpu,driver_version --format=csv,noheader,nounits 2>$null)
$gpu=$null
if($gl -and $gl[0] -notmatch 'failed|error'){$gp=$gl[0] -split ',';if($gp.Count -ge 8){$gpu=[pscustomobject]@{name=$gp[0];util=(cv $gp[1]);memUsed=(cv $gp[2]);memTotal=(cv $gp[3]);power=(cv $gp[4]);powerLimit=(cv $gp[5]);temp=(cv $gp[6]);driver=$gp[7].Trim()}}}
Write-Output '<<<TMU>>>'
ConvertTo-Json $gpu -Compress