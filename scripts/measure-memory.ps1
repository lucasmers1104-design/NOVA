# Measures what NOVA uses in memory right now: nova.exe, its speech helper and the
# WebView2 processes that belong to it (found by NOVA's own WebView2 data folder).
#
#   powershell -File scripts/measure-memory.ps1            one reading
#   powershell -File scripts/measure-memory.ps1 -Samples 5 the median of five, 3 s apart
#
# "Private" is committed memory only this process holds (what Windows gets back when it
# ends); "WorkingSet" is what currently sits in RAM, shared pages included.
param(
  [int]$Samples = 1,
  [int]$PauseSeconds = 3
)

function Read-Nova {
  $all = Get-CimInstance Win32_Process -Filter "Name='nova.exe' OR Name='nova-speech.exe' OR Name='msedgewebview2.exe'"
  $mine = $all | Where-Object { $_.Name -ne 'msedgewebview2.exe' -or $_.CommandLine -like '*dev.nova.commandcenter*' }
  $rows = foreach ($p in $mine) {
    $kind = if ($p.Name -eq 'msedgewebview2.exe') {
      if ($p.CommandLine -match '--type=([a-z-]+)') { "webview:$($Matches[1])" } else { 'webview:browser' }
    } elseif ($p.CommandLine -match '--speech-helper') { 'nova-speech' } else { $p.Name -replace '\.exe$', '' }
    [pscustomobject]@{
      Kind       = $kind
      Pid        = $p.ProcessId
      PrivateMB  = [math]::Round($p.PrivatePageCount / 1MB, 1)
      WorkingMB  = [math]::Round($p.WorkingSetSize / 1MB, 1)
    }
  }
  $rows
}

function Median([double[]]$values) {
  $sorted = $values | Sort-Object
  $sorted[[math]::Floor(($sorted.Count - 1) / 2)]
}

$readings = @()
for ($i = 0; $i -lt $Samples; $i++) {
  if ($i -gt 0) { Start-Sleep -Seconds $PauseSeconds }
  $readings += , @(Read-Nova)
}
$last = $readings[-1]
if (-not $last) { Write-Output 'NOVA is not running.'; exit 1 }

$last | Sort-Object Kind | Format-Table -AutoSize
$native = { param($rows) ($rows | Where-Object { $_.Kind -notlike 'webview:*' } | Measure-Object PrivateMB -Sum).Sum }
$web = { param($rows) ($rows | Where-Object { $_.Kind -like 'webview:*' } | Measure-Object PrivateMB -Sum).Sum }
$total = { param($rows) ($rows | Measure-Object PrivateMB -Sum).Sum }
$working = { param($rows) ($rows | Measure-Object WorkingMB -Sum).Sum }
[pscustomobject]@{
  Samples          = $Samples
  Processes        = $last.Count
  WebViews         = ($last | Where-Object { $_.Kind -like 'webview:*' }).Count
  NativePrivateMB  = [math]::Round((Median ($readings | ForEach-Object { & $native $_ })), 0)
  WebViewPrivateMB = [math]::Round((Median ($readings | ForEach-Object { & $web $_ })), 0)
  TotalPrivateMB   = [math]::Round((Median ($readings | ForEach-Object { & $total $_ })), 0)
  TotalWorkingMB   = [math]::Round((Median ($readings | ForEach-Object { & $working $_ })), 0)
} | Format-List
