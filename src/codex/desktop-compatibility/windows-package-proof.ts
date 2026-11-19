export const CODEX_PACKAGE_FAMILY = "OpenAI.Codex_2p2nqsd0c76g0";
// Store package identity and PE code-signing identity are distinct.
export const CODEX_STORE_PUBLISHER = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
export const CODEX_EXECUTABLE_SIGNER = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US';

/** Shared only with owned-path fixtures. Checked again while the image and manifest handles are held. */
export const DESKTOP_PACKAGE_PATH_GUARD_SCRIPT = [
  "function Assert-DesktopPackagePath([string]$Path){",
  String.raw`if($Path.Length -gt 8192 -or $Path -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($Path) -ine $Path){throw 'Noncanonical package path'}`,
  String.raw`$volume=[IO.Path]::GetPathRoot($Path); $current=$volume; $parts=@($Path.Substring($volume.Length).Split('\')|Where-Object {$_ -ne ''})`,
  "if($parts.Count -gt 128){throw 'Package ancestry too deep'}; $seen=[Collections.Generic.List[string]]::new()",
  "for($i=-1;$i -lt $parts.Count;$i++){",
  "if($i -ge 0){$current=Join-Path $current $parts[$i]}; $item=Get-Item -LiteralPath $current -Force",
  "if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($i -lt $parts.Count-1 -and -not $item.PSIsContainer)){throw 'Reparse package ancestry'}",
  "$seen.Add($item.FullName.ToLowerInvariant()+':'+$item.CreationTimeUtc.Ticks)",
  "}; return ($seen -join '|')",
  "}",
].join("; ");

const WINDOWS_PACKAGE_FILE_SOURCE = String.raw`using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class OpenCodexPackageFile {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint capacity, uint flags);
    public static void AssertPath(FileStream stream, string expected) {
        var path = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(stream.SafeFileHandle, path, (uint)path.Capacity, 0);
        if (length == 0 || length >= path.Capacity ||
            !String.Equals(path.ToString(), @"\\?\" + expected, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Unexpected package file path");
    }
}`;

/** Windows PowerShell 5.1 uses the system AppX module and the .NET Framework WinRT projection. */
export const WINDOWS_PACKAGE_PROOF_FUNCTIONS = [
  "$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'",
  "Import-Module Appx -ErrorAction Stop",
  DESKTOP_PACKAGE_PATH_GUARD_SCRIPT,
  "Add-Type -TypeDefinition @'", WINDOWS_PACKAGE_FILE_SOURCE, "'@",
  "function Get-DesktopPackage {",
  "$packages=@(Get-AppxPackage -Name OpenAI.Codex -PackageTypeFilter Main)",
  "if($packages.Count -ne 1){throw 'Package not unique'}; $package=$packages[0]",
  `if($package.PackageFamilyName -cne '${CODEX_PACKAGE_FAMILY}' -or $package.Publisher -cne '${CODEX_STORE_PUBLISHER}' -or $package.SignatureKind -ne 'Store' -or $package.Status -ne 'Ok' -or $package.IsDevelopmentMode -ne $false){throw 'Untrusted package registration'}`,
  "if([IO.Path]::GetFileName($package.InstallLocation) -cne $package.PackageFullName){throw 'Unexpected package root'}",
  "return $package",
  "}",
  "function Assert-DesktopPackageContent($Package) {",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$manager=[Windows.Management.Deployment.PackageManager,Windows.Management.Deployment,ContentType=WindowsRuntime]::new()",
  "$installed=$manager.FindPackageForUser('', $Package.PackageFullName)",
  "if(-not $installed -or $installed.Id.FullName -cne $Package.PackageFullName -or $installed.InstalledLocation.Path -ine $Package.InstallLocation -or $installed.SignatureKind -ne 'Store' -or -not $installed.Status.VerifyIsOK()){throw 'Package deployment changed'}",
  // Use the OS integrity check for authenticated package contents, including the signed block map.
  '$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object {$_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -ceq \'IAsyncOperation`1\'}',
  "$task=$asTask.MakeGenericMethod([bool]).Invoke($null, @($installed.VerifyContentIntegrityAsync()))",
  "if($task.GetAwaiter().GetResult() -ne $true){throw 'Package content integrity check failed'}",
  "}",
  "function Get-DesktopPackageHash([IO.Stream]$Stream) {",
  "$Stream.Position=0; $sha=[Security.Cryptography.SHA256]::Create()",
  "try{return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}",
  "}",
  "function Assert-DesktopPackageFiles {",
  "if((Assert-DesktopPackagePath $exePath) -cne $exeChain -or (Assert-DesktopPackagePath $manifestPath) -cne $manifestChain){throw 'Package ancestry changed'}",
  "[OpenCodexPackageFile]::AssertPath($exeStream,$exePath); [OpenCodexPackageFile]::AssertPath($manifestStream,$manifestPath)",
  "$again=Get-DesktopPackage",
  "if($again.PackageFullName -cne $p.PackageFullName -or $again.InstallLocation -ine $p.InstallLocation){throw 'Package changed during proof'}",
  "}",
].join("\n");

// The caller closes both handles in a finally block, including when the second open fails.
export const OPEN_WINDOWS_PACKAGE_FILES = [
  String.raw`$exePath=Join-Path $p.InstallLocation 'app\ChatGPT.exe'; $manifestPath=Join-Path $p.InstallLocation 'AppxManifest.xml'`,
  "$exeChain=Assert-DesktopPackagePath $exePath; $manifestChain=Assert-DesktopPackagePath $manifestPath",
  "$exeStream=[IO.File]::Open($exePath,'Open','Read','Read')",
  "$manifestStream=[IO.File]::Open($manifestPath,'Open','Read','Read')",
  "Assert-DesktopPackageFiles",
  "if($exeStream.Length -lt 1 -or $exeStream.Length -gt 1073741824 -or $manifestStream.Length -lt 1 -or $manifestStream.Length -gt 1048576){throw 'Unexpected package file size'}",
].join("\n");

/** Package/app identity can be observed even when content or signer proof later fails. */
export const READ_WINDOWS_PACKAGE_MANIFEST = [
  "$manifest=Get-AppxPackageManifest -Package $p.PackageFullName",
  "$entry=@($manifest.Package.Applications.Application|Where-Object {$_.Id -ceq 'App'})",
  String.raw`if($entry.Count -ne 1 -or $entry[0].Executable.Replace('/','\') -ine 'app\ChatGPT.exe'){throw 'Unexpected application entry'}; $entry=$entry[0]`,
  "if($manifest.Package.Identity.Name -cne 'OpenAI.Codex' -or $manifest.Package.Identity.Publisher -cne $p.Publisher -or $manifest.Package.Identity.Version -cne [string]$p.Version){throw 'Unexpected manifest identity'}",
].join("\n");

export const MEASURE_WINDOWS_PACKAGE_FILES = [
  "Assert-DesktopPackageContent $p",
  "$signature=Get-AuthenticodeSignature -LiteralPath $exePath",
  `if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -cne '${CODEX_EXECUTABLE_SIGNER}'){throw 'Untrusted executable signer'}`,
  READ_WINDOWS_PACKAGE_MANIFEST,
  "$digest=Get-DesktopPackageHash $manifestStream; $executableHash=Get-DesktopPackageHash $exeStream",
  "$exe=Get-Item -LiteralPath $exePath",
  "$executableIdentity=[string]$exeStream.Length+':'+$exe.CreationTimeUtc.Ticks+':'+$exe.LastWriteTimeUtc.Ticks",
  "$sha=[Security.Cryptography.SHA256]::Create()",
  "try{$ancestry=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($exeChain+'|'+$manifestChain)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}",
  "Assert-DesktopPackageFiles",
].join("\n");

export const CLOSE_WINDOWS_PACKAGE_FILES = "if($manifestStream){$manifestStream.Dispose()}; if($exeStream){$exeStream.Dispose()}";
