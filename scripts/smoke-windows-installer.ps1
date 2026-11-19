param(
    [Parameter(Mandatory)]
    [string]$Installer
)

$ErrorActionPreference = 'Stop'
$setup = (Resolve-Path -LiteralPath $Installer).Path
$destination = Join-Path $env:RUNNER_TEMP 'MasterDeck installer smoke test'
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'MasterDeck.lnk'
$programs = [Environment]::GetFolderPath('Programs')
$application = Join-Path $destination 'hubdeck.exe'
$uninstaller = Join-Path $destination 'uninstall.exe'

function Invoke-CheckedProcess([string]$Exe, [string]$Arguments) {
    $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "$Exe exited with code $($process.ExitCode)"
    }
}

Invoke-CheckedProcess $setup "/S /D=$destination"
try {
    if (!(Test-Path -LiteralPath $application) -or !(Test-Path -LiteralPath $uninstaller)) {
        throw 'Setup did not install MasterDeck and its uninstaller.'
    }
    $startMenu = @(Get-ChildItem -LiteralPath $programs -Filter 'MasterDeck.lnk' -File -Recurse)
    if (!(Test-Path -LiteralPath $desktop) -or $startMenu.Count -ne 1) {
        throw 'Setup did not create the Windows desktop and Start menu shortcuts.'
    }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcut in @($desktop, $startMenu[0].FullName)) {
        if ($shell.CreateShortcut($shortcut).TargetPath -ne $application) {
            throw "The shortcut $shortcut does not launch the installed MasterDeck executable."
        }
    }
    $binary = [System.IO.BinaryReader]::new([System.IO.File]::OpenRead($application))
    try {
        $binary.BaseStream.Position = 0x3c
        $binary.BaseStream.Position = $binary.ReadUInt32()
        if ($binary.ReadUInt32() -ne 0x4550 -or $binary.ReadUInt16() -ne 0x8664) {
            throw 'The installed MasterDeck binary is not Windows x64.'
        }
    } finally {
        $binary.Dispose()
    }
    Invoke-CheckedProcess $application 'cli --help'
} finally {
    if (Test-Path -LiteralPath $uninstaller) {
        Invoke-CheckedProcess $uninstaller '/S'
    }
}
if ((Test-Path -LiteralPath $application) -or (Test-Path -LiteralPath $desktop) -or
    @(Get-ChildItem -LiteralPath $programs -Filter 'MasterDeck.lnk' -File -Recurse).Count -ne 0) {
    throw 'Uninstall did not remove MasterDeck and its shortcuts.'
}
Write-Host 'Windows x64 installation, executable launch, shortcuts and uninstall passed.'
