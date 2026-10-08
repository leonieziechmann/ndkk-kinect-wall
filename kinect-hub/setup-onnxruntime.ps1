# setup-onnxruntime.ps1 - ONNX Runtime with DirectML for the pose model of kinect-hub (src/pose.rs).
#
# Fetches the official NuGet package Microsoft.ML.OnnxRuntime.DirectML 1.24.4 (12.5 MB, the newest
# ONNX Runtime with DirectML), checks its SHA-256 and Microsoft's signature on the DLL, and puts
# only onnxruntime.dll into kinect-hub/onnxruntime/ (git-ignored). Once per checkout:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File kinect-hub\setup-onnxruntime.ps1
#
# A running hub picks the DLL up within 10 s. DirectML.dll itself comes with Windows 10/11
# (System32); if the hub reports it as too old, put DirectML.dll from the NuGet package
# Microsoft.AI.DirectML next to onnxruntime.dll.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar slows Invoke-WebRequest down a lot
$version = '1.24.4'
$sha256 = '57E9F11B73437BEF7A309496135D4C1F96B1A8E9DDBA60013FA27BFC1D788681'
$url = "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/$version/microsoft.ml.onnxruntime.directml.$version.nupkg"
$dir = Join-Path $PSScriptRoot 'onnxruntime'
$dll = Join-Path $dir 'onnxruntime.dll'

if (Test-Path $dll) {
    $have = (Get-Item $dll).VersionInfo.FileVersion
    if ($have -like "$($version.Substring(0, 4))*") {
        Write-Host "onnxruntime.dll $have is already there: $dll"
        exit 0
    }
    Write-Host "replacing onnxruntime.dll $have"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("onnxruntime-directml-$version-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    $pkg = Join-Path $tmp 'package.nupkg'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $pkg -UseBasicParsing
    $got = (Get-FileHash $pkg -Algorithm SHA256).Hash
    if ($got -ne $sha256) {
        throw "the package has SHA-256 $got, expected $sha256; not installed"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($pkg)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq 'runtimes/win-x64/native/onnxruntime.dll' } | Select-Object -First 1
        if (-not $entry) { throw 'onnxruntime.dll for win-x64 is missing in the package' }
        $part = Join-Path $tmp 'onnxruntime.dll'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $part, $true)
    } finally {
        $zip.Dispose()
    }

    $sig = Get-AuthenticodeSignature $part
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "onnxruntime.dll is not validly signed by Microsoft ($($sig.Status)); not installed"
    }

    New-Item -ItemType Directory -Force $dir | Out-Null
    Move-Item -Force $part $dll
    Write-Host "installed onnxruntime.dll $((Get-Item $dll).VersionInfo.FileVersion): $dll"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
