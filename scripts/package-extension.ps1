$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $Root 'manifest.json'
$Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
$Version = $Manifest.version
$ZipPath = Join-Path $Root ("haddan-market-helper-v{0}.zip" -f $Version)
$TempDir = Join-Path $env:TEMP ("hmh-package-{0}" -f ([guid]::NewGuid().ToString('N')))

New-Item -ItemType Directory -Path $TempDir | Out-Null

try {
  $Items = @('manifest.json', 'background.js', 'offscreen.html', 'offscreen.js', 'content', 'popup', 'README.md', 'CHANGELOG.md', 'RELEASE_CHECKLIST.md')
  foreach ($Item in $Items) {
    $Source = Join-Path $Root $Item
    if (!(Test-Path -LiteralPath $Source)) { continue }
    $Destination = Join-Path $TempDir $Item
    if ((Get-Item -LiteralPath $Source).PSIsContainer) {
      Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
    } else {
      Copy-Item -LiteralPath $Source -Destination $Destination
    }
  }

  if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }
  Compress-Archive -LiteralPath (Join-Path $TempDir '*') -DestinationPath $ZipPath -Force
  Write-Host "Created $ZipPath"
} finally {
  if (Test-Path -LiteralPath $TempDir) {
    Remove-Item -LiteralPath $TempDir -Recurse -Force
  }
}
