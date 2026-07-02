$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $parts = $line -split '=', 2
        if ($parts.Count -ne 2) { continue }
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
    }
}
$node = if ($env:NODE_PATH) { $env:NODE_PATH } else { 'node' }
$server = Join-Path $root 'dist/index.js'
if (-not (Test-Path $server)) {
    Push-Location $root
    try {
        npm run build
    } finally {
        Pop-Location
    }
}
& $node $server
