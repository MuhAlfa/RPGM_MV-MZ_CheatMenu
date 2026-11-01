@echo off
title CheatMenu - Uninstaller
rem Run the powershell script that sits below this file
set "CM_ROOT=%~dp0"
set "CM_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText($env:CM_SELF); $code = ($s -split '(?m)^###PS###\r?$')[1]; Invoke-Expression $code"
echo.
pause
exit /b

###PS###
$ErrorActionPreference = 'Stop'

#What gets removed: the plugin name
$name = 'CheatMenu'
$root = $env:CM_ROOT.TrimEnd('\')
$utf8 = New-Object System.Text.UTF8Encoding($false)

#Remove one entry from the plugins.js text, the comma on the line before gets fixed too
function Remove-Entry($text, $name) {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in [regex]::Split($text, '(?<=\n)')) { if ($l -ne '') { $lines.Add($l) } }

    $idx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ('^\s*\{\s*"name"\s*:\s*"' + [regex]::Escape($name) + '"')) { $idx = $i; break }
    }
    if ($idx -lt 0) { return $text }

    $lines.RemoveAt($idx)

    #If the removed entry was the last one, drop the comma on the line before
    if ($idx -gt 0 -and $idx -lt $lines.Count -and $lines[$idx].TrimStart().StartsWith(']')) {
        $prev = $lines[$idx - 1]
        $eol = ''
        if ($prev.EndsWith("`r`n")) { $eol = "`r`n" } elseif ($prev.EndsWith("`n")) { $eol = "`n" }
        $body = $prev.TrimEnd()
        if ($body.EndsWith(',')) { $body = $body.Substring(0, $body.Length - 1) }
        $lines[$idx - 1] = $body + $eol
    }
    return ($lines -join '')
}

try {
    #Find plugins.js (MV: www\js, MZ: js)
    $path = @("$root\www\js\plugins.js", "$root\js\plugins.js") |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $path) { throw "Could not find plugins.js. Run this from the game folder (next to Game.exe)." }
    $plugin_dir = Join-Path (Split-Path $path) 'plugins'

    #Delete the plugin file
    $js = Join-Path $plugin_dir ($name + '.js')
    if (Test-Path -LiteralPath $js) {
        Remove-Item -LiteralPath $js -Force
        Write-Host "Deleted $js"
    }

    #Remove the entry from plugins.js
    $text_before = [IO.File]::ReadAllText($path, $utf8)
    $text = Remove-Entry $text_before $name

    if ($text -cne $text_before) {
        if (-not (Test-Path -LiteralPath "$path.bak")) { Copy-Item -LiteralPath $path -Destination "$path.bak" }
        [IO.File]::WriteAllText($path, $text, $utf8)
        Write-Host "Removed $name from plugins.js"
        Write-Host ""
        Write-Host "Cheat menu uninstalled."
    } else {
        Write-Host "Nothing to remove in plugins.js."
    }
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}