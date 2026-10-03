# Usage: pwsh check-acl.ps1 <file> [<file> ...]
# Fails when anyone other than this user, SYSTEM or Administrators is allowed to read a file.
$allowed = @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators", "$env:USERDOMAIN\$env:USERNAME")
$bad = 0
foreach ($file in $args) {
  foreach ($rule in (Get-Acl $file).Access) {
    if ($rule.AccessControlType -ne "Allow") { continue }
    if ($rule.FileSystemRights -notmatch "Read|FullControl|Modify") { continue }
    $who = $rule.IdentityReference.Value
    if ($allowed -notcontains $who) { Write-Output "too open: $file readable by $who"; $bad = 1 }
  }
  Write-Output "checked: $file"
}
exit $bad
