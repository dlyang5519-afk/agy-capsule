param(
    [switch]$AutoLaunch
)

# Antigravity Multi-Layer Context Floating Stack
# - Shows one aligned layer per active root project (auto-expands upward/downward, zero row jumping)
# - Distinguishes "AI Running (⚡)" vs "Waiting for User 4:00 Cache Countdown (⏱)"
# - Double-clicking Desktop shortcut ALWAYS summons, restores hidden layers, and pulls window to current monitor
# - Clicking '×' on all layers cleanly hides the bar until a new message/chat arrives or shortcut is clicked

$scriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript  = Join-Path $scriptDir "server.mjs"
$prefsPath     = Join-Path $scriptDir "prefs.json"
$errLogPath    = Join-Path $scriptDir "last_error.log"
$summonPath    = Join-Path $scriptDir "summon.flag"
$reloadPath    = Join-Path $scriptDir "reload.flag"
$launchVbsPath = Join-Path $scriptDir "launch.vbs"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CapsuleWin32 {
    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr GetThreadDesktop(uint dwThreadId);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static string GetCurrentDesktopName() {
        try {
            IntPtr h = GetThreadDesktop(GetCurrentThreadId());
            if (h == IntPtr.Zero) return "";
            var sb = new StringBuilder(256);
            int needed;
            if (GetUserObjectInformation(h, 2, sb, 256, out needed)) {
                return sb.ToString();
            }
        } catch {}
        return "";
    }
}
"@

# Never run or grab mutex inside an isolated non-interactive tool desktop (e.g. exebox-*)
$curDesktop = [CapsuleWin32]::GetCurrentDesktopName()
if ($curDesktop -and $curDesktop -match '^exebox') {
    exit 0
}

# Load or initialize user preferences
$prefs = [PSCustomObject]@{
    left            = $null
    top             = $null
    anchorBottom    = $null
    theme           = "dark"
    soundEnabled    = $true
    alertThresholdK = 100
    opacity         = 0.96
    autoStart       = $true
    autoExitWithAgy = $true
    activeWindowMin = 60
}

if (Test-Path $prefsPath) {
    try {
        $loaded = Get-Content -Path $prefsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $loaded.left) { $prefs.left = [double]$loaded.left }
        if ($null -ne $loaded.top) { $prefs.top = [double]$loaded.top }
        if ($null -ne $loaded.anchorBottom) { $prefs.anchorBottom = [double]$loaded.anchorBottom }
        if ($loaded.theme -in @("dark", "light")) { $prefs.theme = $loaded.theme }
        if ($null -ne $loaded.soundEnabled) { $prefs.soundEnabled = [bool]$loaded.soundEnabled }
        if ($loaded.alertThresholdK -in @(50, 100, 180)) { $prefs.alertThresholdK = [int]$loaded.alertThresholdK }
        if ($null -ne $loaded.opacity) { $prefs.opacity = [double]$loaded.opacity }
        if ($null -ne $loaded.autoStart) { $prefs.autoStart = [bool]$loaded.autoStart }
        if ($null -ne $loaded.autoExitWithAgy) { $prefs.autoExitWithAgy = [bool]$loaded.autoExitWithAgy }
        if ($loaded.activeWindowMin -in @(30, 60, 120, 360)) { $prefs.activeWindowMin = [int]$loaded.activeWindowMin }
    } catch {}
}

if ($AutoLaunch -and (-not $prefs.autoStart)) {
    exit 0
}

# Single-instance check with Summon + Self-Heal
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\AntigravityContextCapsule_v1", [ref]$createdNew)
if (-not $createdNew) {
    try { $mutex.Dispose() } catch {}
    if ($AutoLaunch) {
        try { Set-Content -Path $summonPath -Value "wake" -Encoding UTF8 -Force } catch {}
        exit 0
    }

    # Manual launch (user double-clicked Desktop shortcut): summon running instance to current screen!
    try { Set-Content -Path $summonPath -Value "summon" -Encoding UTF8 -Force } catch {}
    $ack = $false
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 150
        if (-not (Test-Path $summonPath)) {
            $ack = $true
            break
        }
    }
    if ($ack) {
        exit 0
    }

    # Self-heal fallback: old instance did not respond within 1.8s -> terminate stale instance and start fresh
    try {
        Get-CimInstance Win32_Process | Where-Object {
            $_.ProcessId -ne $PID -and ($_.CommandLine -match 'capsule\.ps1|agy-capsule\\server\.mjs')
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {}
    try { Remove-Item $summonPath -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 350

    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, "Local\AntigravityContextCapsule_v1", [ref]$createdNew)
    if (-not $createdNew) {
        exit 0
    }
}

try { Remove-Item $summonPath -Force -ErrorAction SilentlyContinue } catch {}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Save-Prefs {
    try {
        $prefs | ConvertTo-Json | Set-Content -Path $prefsPath -Encoding UTF8
    } catch {}
}

if (Test-Path $errLogPath) {
    try { Remove-Item $errLogPath -Force -ErrorAction SilentlyContinue } catch {}
}

# Resolve node.exe reliably across PATH and common Windows / NVM / FNM locations
$nodeExe = "node"
$cmdNode = Get-Command node -ErrorAction SilentlyContinue
if ($cmdNode -and $cmdNode.Source) {
    $nodeExe = $cmdNode.Source
} else {
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:NVM_SYMLINK\node.exe",
        "$env:USERPROFILE\scoop\apps\nodejs\current\node.exe"
    )
    foreach ($cand in $candidates) {
        if ($cand -and (Test-Path $cand)) {
            $nodeExe = $cand
            break
        }
    }
}

# Start hidden Node.js telemetry server
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodeExe
$psi.Arguments = "`"$serverScript`""
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $false
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = $scriptDir

$nodeProc = [System.Diagnostics.Process]::Start($psi)
$portLine = $nodeProc.StandardOutput.ReadLine()
$port = 0
if ($portLine -match "PORT=(\d+)") {
    $port = [int]$Matches[1]
} else {
    try { $nodeProc.Kill() } catch {}
    [System.Windows.MessageBox]::Show("无法启动本地遥测服务，请确认 Node.js 可用。", "上下文胶囊")
    exit 1
}
$baseUrl = "http://127.0.0.1:$port"
$apiUrl  = "$baseUrl/state"

$script:webClient = New-Object System.Net.WebClient
$script:webClient.Encoding = [System.Text.Encoding]::UTF8
$script:webClient.Proxy = $null

# Sync configured activeWindowMin to backend
try {
    [void]$script:webClient.DownloadString("$baseUrl/window?min=$($prefs.activeWindowMin)")
} catch {}

# Multi-monitor DPI-aware screen helpers
function Get-DpiScale {
    try {
        if ($null -ne $script:window) {
            $src = [System.Windows.PresentationSource]::FromVisual($script:window)
            if ($null -ne $src -and $null -ne $src.CompositionTarget) {
                $m = $src.CompositionTarget.TransformToDevice.M11
                if ($m -gt 0.2) { return [double]$m }
            }
        }
    } catch {}
    return 1.0
}

function Convert-ScreenWorkAreaToDip($screen) {
    $scale = Get-DpiScale
    $wa = $screen.WorkingArea
    return [PSCustomObject]@{
        Left   = [double]($wa.Left / $scale)
        Top    = [double]($wa.Top / $scale)
        Width  = [double]($wa.Width / $scale)
        Height = [double]($wa.Height / $scale)
        Right  = [double]($wa.Right / $scale)
        Bottom = [double]($wa.Bottom / $scale)
    }
}

function Get-CursorWorkArea {
    try {
        $pt = [System.Windows.Forms.Cursor]::Position
        $scr = [System.Windows.Forms.Screen]::FromPoint($pt)
        if ($null -ne $scr) { return (Convert-ScreenWorkAreaToDip $scr) }
    } catch {}
    $wa = [System.Windows.SystemParameters]::WorkArea
    return [PSCustomObject]@{
        Left = $wa.Left; Top = $wa.Top; Width = $wa.Width; Height = $wa.Height
        Right = $wa.Right; Bottom = $wa.Bottom
    }
}

function Get-WorkAreaForDipPoint([double]$dipX, [double]$dipY) {
    try {
        $scale = Get-DpiScale
        $pt = New-Object System.Drawing.Point([int][Math]::Round($dipX * $scale), [int][Math]::Round($dipY * $scale))
        $scr = [System.Windows.Forms.Screen]::FromPoint($pt)
        if ($null -ne $scr) { return (Convert-ScreenWorkAreaToDip $scr) }
    } catch {}
    return (Get-CursorWorkArea)
}

function Test-DipPointVisibleOnAnyScreen([double]$dipX, [double]$dipY) {
    try {
        $scale = Get-DpiScale
        $px = [int][Math]::Round(($dipX + 80) * $scale)
        $py = [int][Math]::Round(($dipY + 20) * $scale)
        foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
            if ($scr.WorkingArea.Contains($px, $py)) { return $true }
        }
        return $false
    } catch {
        return $true
    }
}

# Outer Glass Container XAML
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Antigravity 多开上下文悬浮栈"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        ResizeMode="NoResize"
        SizeToContent="WidthAndHeight"
        UseLayoutRounding="True"
        SnapsToDevicePixels="True"
        TextOptions.TextFormattingMode="Display"
        TextOptions.TextRenderingMode="ClearType">

    <Grid Margin="14,10,14,16">
        <Border x:Name="CardBorder"
                CornerRadius="15"
                Padding="10,5,8,5"
                BorderThickness="1"
                Background="#EE13161C"
                BorderBrush="#2CFFFFFF"
                Cursor="Arrow">
            <Border.Effect>
                <DropShadowEffect x:Name="CardShadow"
                                  BlurRadius="18"
                                  ShadowDepth="4"
                                  Direction="270"
                                  Color="#000000"
                                  Opacity="0.40"/>
            </Border.Effect>

            <StackPanel x:Name="RowsStack"
                        Orientation="Vertical"
                        Grid.IsSharedSizeScope="True"/>
        </Border>
    </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$script:window = $window

$cardBorder = $window.FindName("CardBorder")
$cardShadow = $window.FindName("CardShadow")
$rowsStack  = $window.FindName("RowsStack")

$brushConverter = New-Object System.Windows.Media.BrushConverter
function To-Brush([string]$hex) {
    return $brushConverter.ConvertFromString($hex)
}

$fontMain = New-Object System.Windows.Media.FontFamily("Microsoft YaHei UI, Segoe UI")
$fontMono = New-Object System.Windows.Media.FontFamily("Consolas, Microsoft YaHei UI, Segoe UI")

function Move-ToCurrentScreenBottom {
    $wa = Get-CursorWorkArea
    $estW = if ($window.ActualWidth -gt 60) { $window.ActualWidth } else { 490.0 }
    $estH = if ($window.ActualHeight -gt 24) { $window.ActualHeight } else { 68.0 }
    $script:repositioning = $true
    $window.Left = [Math]::Round($wa.Left + (($wa.Width - $estW) / 2.0), 1)
    $window.Top  = [Math]::Round($wa.Bottom - $estH - 16.0, 1)
    $script:anchorBottom = [Math]::Round($window.Top + $estH, 1)
    $script:lastSavedLeft = $window.Left
    $script:lastSavedTop  = $window.Top
    $prefs.left = $script:lastSavedLeft
    $prefs.top  = $script:lastSavedTop
    $prefs.anchorBottom = $script:anchorBottom
    $script:repositioning = $false
    Save-Prefs
}

# Initial window placement (multi-monitor aware; manual launch defaults to cursor's monitor if off-screen)
$initWa = Get-CursorWorkArea
$hasValidSavedPos = ($null -ne $prefs.left) -and ($null -ne $prefs.top) -and (Test-DipPointVisibleOnAnyScreen $prefs.left $prefs.top)

if ($hasValidSavedPos -and $AutoLaunch) {
    $window.Left = $prefs.left
    $window.Top  = $prefs.top
} elseif ($hasValidSavedPos -and (-not $AutoLaunch)) {
    # Manual launch: if saved position was on a DIFFERENT monitor than the cursor, bring it to cursor's monitor!
    $savedWa = Get-WorkAreaForDipPoint ($prefs.left + 80) ($prefs.top + 20)
    if ([Math]::Abs($savedWa.Left - $initWa.Left) -gt 50 -or [Math]::Abs($savedWa.Top - $initWa.Top) -gt 50) {
        $window.Left = [Math]::Round($initWa.Left + (($initWa.Width - 490.0) / 2.0), 1)
        $window.Top  = [Math]::Round($initWa.Bottom - 84.0, 1)
        $prefs.left = $window.Left
        $prefs.top  = $window.Top
        $prefs.anchorBottom = $window.Top + 68.0
        Save-Prefs
    } else {
        $window.Left = $prefs.left
        $window.Top  = $prefs.top
    }
} else {
    $window.Left = [Math]::Round($initWa.Left + (($initWa.Width - 490.0) / 2.0), 1)
    $window.Top  = [Math]::Round($initWa.Bottom - 84.0, 1)
    $prefs.left = $window.Left
    $prefs.top  = $window.Top
    $prefs.anchorBottom = $window.Top + 68.0
    Save-Prefs
}
$window.Opacity = $prefs.opacity

# Track vertical anchor per-monitor so adding/removing layers expands UPWARD when placed in lower half of screen
$script:repositioning = $false
$script:anchorBottom = if ($null -ne $prefs.anchorBottom) { [double]$prefs.anchorBottom } else { $window.Top + 68.0 }

$window.Add_SizeChanged({
    param($s, $e)
    try {
        if (-not $e.HeightChanged) { return }
        if ($e.NewSize.Height -le 10) { return }
        $wa = Get-WorkAreaForDipPoint ($window.Left + 80) ($window.Top + 20)
        $midY = $wa.Top + ($wa.Height * 0.45)
        if ($window.Top -ge $midY -or ($script:anchorBottom -gt ($midY + 60))) {
            $script:repositioning = $true
            $newTop = $script:anchorBottom - $e.NewSize.Height
            $newTop = [Math]::Max($wa.Top, [Math]::Min($wa.Bottom - 46, $newTop))
            $window.Top = $newTop
            $script:lastSavedTop = [Math]::Round($window.Top, 1)
            $script:repositioning = $false
        }
    } catch {
        $script:repositioning = $false
    }
})

function Format-WindowLabel([int]$min) {
    switch ($min) {
        30   { return "30分钟" }
        60   { return "1小时" }
        120  { return "2小时" }
        default { return "6小时" }
    }
}

function Assert-WindowTopmost {
    try {
        if ($window.WindowState -eq [System.Windows.WindowState]::Minimized) {
            $window.WindowState = [System.Windows.WindowState]::Normal
        }
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
        if ($hwnd -ne [IntPtr]::Zero) {
            # HWND_TOPMOST = -1, SWP_NOMOVE(0x2) | SWP_NOSIZE(0x1) | SWP_NOACTIVATE(0x10) | SWP_SHOWWINDOW(0x40) = 0x0053
            [void][CapsuleWin32]::SetWindowPos($hwnd, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0053)
        }
        $window.Topmost = $false
        $window.Topmost = $true
    } catch {}
}

# Right-Click Context Menu
$menu = New-Object System.Windows.Controls.ContextMenu

$miWinRange = New-Object System.Windows.Controls.MenuItem
$miWinRange.Header = "📂 显示活跃范围：最近 $(Format-WindowLabel $prefs.activeWindowMin)"
$miWinRange.Add_Click({
    $prefs.activeWindowMin = switch ($prefs.activeWindowMin) {
        30   { 60 }
        60   { 120 }
        120  { 360 }
        default { 30 }
    }
    $miWinRange.Header = "📂 显示活跃范围：最近 $(Format-WindowLabel $prefs.activeWindowMin)"
    Save-Prefs
    try {
        $json = $script:webClient.DownloadString("$baseUrl/window?min=$($prefs.activeWindowMin)")
        $script:payload = $json | ConvertFrom-Json
        Update-UI
    } catch {}
})

$miRestore = New-Object System.Windows.Controls.MenuItem
$miRestore.Header = "🔄 恢复已手动隐藏的项目层"
$miRestore.Add_Click({
    try {
        $json = $script:webClient.DownloadString("$baseUrl/restore")
        $script:payload = $json | ConvertFrom-Json
        Update-UI
    } catch {}
})

$miCenterHere = New-Object System.Windows.Controls.MenuItem
$miCenterHere.Header = "📍 移回当前屏幕底部居中"
$miCenterHere.Add_Click({
    Move-ToCurrentScreenBottom
})

$miAutoStart = New-Object System.Windows.Controls.MenuItem
$miAutoStart.Header = if ($prefs.autoStart) { "🚀 随反重力自动启停：已开启" } else { "⏸ 随反重力自动启停：已关闭" }
$miAutoStart.Add_Click({
    $newState = -not $prefs.autoStart
    $prefs.autoStart = $newState
    $prefs.autoExitWithAgy = $newState
    $miAutoStart.Header = if ($prefs.autoStart) { "🚀 随反重力自动启停：已开启" } else { "⏸ 随反重力自动启停：已关闭" }
    Save-Prefs
})

$miTheme = New-Object System.Windows.Controls.MenuItem
$miTheme.Header = if ($prefs.theme -eq "dark") { "☀️ 切换为浅色主题" } else { "🌙 切换为深色主题" }
$miTheme.Add_Click({
    $prefs.theme = if ($prefs.theme -eq "dark") { "light" } else { "dark" }
    $miTheme.Header = if ($prefs.theme -eq "dark") { "☀️ 切换为浅色主题" } else { "🌙 切换为深色主题" }
    $script:currentSig = "__force_rebuild__"
    Apply-OuterTheme
    Save-Prefs
    Update-UI
})

$miSound = New-Object System.Windows.Controls.MenuItem
$miSound.Header = if ($prefs.soundEnabled) { "🔊 剩45秒提醒音：已开启" } else { "🔇 剩45秒提醒音：已静音" }
$miSound.Add_Click({
    $prefs.soundEnabled = -not $prefs.soundEnabled
    $miSound.Header = if ($prefs.soundEnabled) { "🔊 剩45秒提醒音：已开启" } else { "🔇 剩45秒提醒音：已静音" }
    Save-Prefs
})

$miThreshold = New-Object System.Windows.Controls.MenuItem
$miThreshold.Header = "🎯 提醒阈值：≥ $($prefs.alertThresholdK)K"
$miThreshold.Add_Click({
    $prefs.alertThresholdK = switch ($prefs.alertThresholdK) {
        50  { 100 }
        100 { 180 }
        default { 50 }
    }
    $miThreshold.Header = "🎯 提醒阈值：≥ $($prefs.alertThresholdK)K"
    Save-Prefs
})

$miOpacity = New-Object System.Windows.Controls.MenuItem
$miOpacity.Header = "👁 透明度：$([int]($prefs.opacity * 100))%"
$miOpacity.Add_Click({
    if ($prefs.opacity -ge 0.94) { $prefs.opacity = 0.85 }
    elseif ($prefs.opacity -ge 0.80) { $prefs.opacity = 0.72 }
    else { $prefs.opacity = 0.96 }
    $window.Opacity = $prefs.opacity
    $miOpacity.Header = "👁 透明度：$([int]($prefs.opacity * 100))%"
    Save-Prefs
})

$sep1 = New-Object System.Windows.Controls.Separator
$sep2 = New-Object System.Windows.Controls.Separator

$miExit = New-Object System.Windows.Controls.MenuItem
$miExit.Header = "❌ 彻底退出悬浮面板"
$miExit.Add_Click({ $window.Close() })

[void]$menu.Items.Add($miWinRange)
[void]$menu.Items.Add($miRestore)
[void]$menu.Items.Add($miCenterHere)
[void]$menu.Items.Add($sep1)
[void]$menu.Items.Add($miAutoStart)
[void]$menu.Items.Add($miTheme)
[void]$menu.Items.Add($miSound)
[void]$menu.Items.Add($miThreshold)
[void]$menu.Items.Add($miOpacity)
[void]$menu.Items.Add($sep2)
[void]$menu.Items.Add($miExit)
$cardBorder.ContextMenu = $menu

$menu.Add_Opened({
    try {
        $hc = if ($script:payload -and $null -ne $script:payload.hiddenCount) { [int]$script:payload.hiddenCount } else { 0 }
        $miRestore.Header = if ($hc -gt 0) { "🔄 恢复已隐藏的项目层（$hc 个）" } else { "🔄 恢复已隐藏的项目层" }
        $miRestore.IsEnabled = ($hc -gt 0)
    } catch {}
})

function Apply-OuterTheme {
    if ($prefs.theme -eq "light") {
        $cardBorder.Background = To-Brush "#F4FFFFFF"
        $cardBorder.BorderBrush = To-Brush "#220F172A"
        $cardShadow.Opacity = 0.18
    } else {
        $cardBorder.Background = To-Brush "#EE13161C"
        $cardBorder.BorderBrush = To-Brush "#2CFFFFFF"
        $cardShadow.Opacity = 0.40
    }
}
Apply-OuterTheme

# Crash-free Win32 Drag (ignores clicks already handled by a row's '×' dismiss button)
$cardBorder.Add_MouseLeftButtonDown({
    param($s, $e)
    try {
        if ($e.Handled) { return }
        if ($e.LeftButton -eq [System.Windows.Input.MouseButtonState]::Pressed) {
            $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
            if ($hwnd -ne [IntPtr]::Zero) {
                [void][CapsuleWin32]::ReleaseCapture()
                [void][CapsuleWin32]::PostMessage($hwnd, 0x00A1, 0x0002, 0)
            }
        }
    } catch {}
})

# State
$script:payload         = $null
$script:currentSig      = ""
$script:rowMap          = @{}
$script:alertedMap      = @{}
$script:lastFetched     = [DateTime]::MinValue
$script:lastAgyCheck    = [DateTime]::MinValue
$script:startedAt       = [DateTime]::Now
$script:sawAntigravity  = $false
$script:agyMissingSince = $null
$script:pulsePhase      = $false
$script:flashTicks      = if ($AutoLaunch) { 0 } else { 4 }
$script:forceShowUntil  = if ($AutoLaunch) { [DateTime]::MinValue } else { [DateTime]::Now.AddSeconds(20) }
$script:lastSavedLeft   = $window.Left
$script:lastSavedTop    = $window.Top

function Format-Tokens([double]$n) {
    if ($n -ge 1000000) { return ("{0:F2}M" -f ($n / 1000000.0)) }
    if ($n -ge 100000)  { return ("{0:F0}K" -f ($n / 1000.0)) }
    if ($n -ge 1000)    { return ("{0:F1}K" -f ($n / 1000.0)) }
    return ("{0:F0}" -f $n)
}

function Format-MmSs([int]$totalSec) {
    if ($totalSec -lt 0) { $totalSec = 0 }
    $m = [int][Math]::Floor($totalSec / 60.0)
    $s = [int]($totalSec % 60)
    return ("{0:D2}:{1:D2}" -f $m, $s)
}

function Add-SharedCol($grid, [string]$groupName) {
    $col = New-Object System.Windows.Controls.ColumnDefinition
    $col.Width = [System.Windows.GridLength]::Auto
    if ($groupName) {
        $col.SharedSizeGroup = $groupName
    }
    [void]$grid.ColumnDefinitions.Add($col)
}

function New-ProjectRow([string]$convId) {
    $isLight = ($prefs.theme -eq "light")
    $mutedFg = To-Brush $(if ($isLight) { "#64748B" } else { "#94A3B8" })
    $mainFg  = To-Brush $(if ($isLight) { "#0F172A" } else { "#F8FAFC" })
    $divBg   = To-Brush $(if ($isLight) { "#180F172A" } else { "#22FFFFFF" })

    $rowBorder = New-Object System.Windows.Controls.Border
    $rowBorder.CornerRadius = New-Object System.Windows.CornerRadius(9)
    $rowBorder.Padding = New-Object System.Windows.Thickness(5, 4, 3, 4)
    $rowBorder.Background = [System.Windows.Media.Brushes]::Transparent

    $grid = New-Object System.Windows.Controls.Grid
    $grid.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    Add-SharedCol $grid "G_Dot"
    Add-SharedCol $grid "G_Title"
    Add-SharedCol $grid "G_Model"
    Add-SharedCol $grid "G_Ctx"
    Add-SharedCol $grid "G_Cache"
    Add-SharedCol $grid "G_Timer"
    Add-SharedCol $grid "G_Chip"
    Add-SharedCol $grid "G_Close"

    # Col 0: Status Dot + Halo
    $dotGrid = New-Object System.Windows.Controls.Grid
    $dotGrid.Width = 10
    $dotGrid.Height = 10
    $dotGrid.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
    $dotGrid.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    $halo = New-Object System.Windows.Shapes.Ellipse
    $halo.Width = 10; $halo.Height = 10; $halo.Fill = To-Brush "#3322C55E"
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 6.5; $dot.Height = 6.5; $dot.Fill = To-Brush "#22C55E"
    [void]$dotGrid.Children.Add($halo)
    [void]$dotGrid.Children.Add($dot)
    [System.Windows.Controls.Grid]::SetColumn($dotGrid, 0)
    [void]$grid.Children.Add($dotGrid)

    # Col 1: Project Title
    $titleText = New-Object System.Windows.Controls.TextBlock
    $titleText.FontFamily = $fontMain
    $titleText.FontSize = 12
    $titleText.FontWeight = [System.Windows.FontWeights]::SemiBold
    $titleText.Foreground = $mainFg
    $titleText.Width = 132
    $titleText.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
    $titleText.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    $titleText.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
    [System.Windows.Controls.Grid]::SetColumn($titleText, 1)
    [void]$grid.Children.Add($titleText)

    # Col 2: Model Badge
    $modelBadge = New-Object System.Windows.Controls.Border
    $modelBadge.CornerRadius = New-Object System.Windows.CornerRadius(6)
    $modelBadge.Padding = New-Object System.Windows.Thickness(5.5, 1, 5.5, 1.5)
    $modelBadge.Background = To-Brush $(if ($isLight) { "#120F172A" } else { "#1AFFFFFF" })
    $modelBadge.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    $modelBadge.Margin = New-Object System.Windows.Thickness(0, 0, 9, 0)
    $modelText = New-Object System.Windows.Controls.TextBlock
    $modelText.FontFamily = $fontMain
    $modelText.FontSize = 10.5
    $modelText.FontWeight = [System.Windows.FontWeights]::SemiBold
    $modelText.Foreground = To-Brush $(if ($isLight) { "#334155" } else { "#CBD5E1" })
    $modelBadge.Child = $modelText
    [System.Windows.Controls.Grid]::SetColumn($modelBadge, 2)
    [void]$grid.Children.Add($modelBadge)

    # Col 3: Context K + % + Mini Bar + Divider
    $ctxStack = New-Object System.Windows.Controls.StackPanel
    $ctxStack.Orientation = [System.Windows.Controls.Orientation]::Horizontal
    $ctxStack.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    $ctxVal = New-Object System.Windows.Controls.TextBlock
    $ctxVal.FontFamily = $fontMain; $ctxVal.FontSize = 12; $ctxVal.FontWeight = [System.Windows.FontWeights]::SemiBold
    $ctxVal.Foreground = $mainFg; $ctxVal.MinWidth = 38; $ctxVal.TextAlignment = [System.Windows.TextAlignment]::Right
    $ctxVal.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    $ctxPct = New-Object System.Windows.Controls.TextBlock
    $ctxPct.FontFamily = $fontMain; $ctxPct.FontSize = 10.5; $ctxPct.Foreground = $mutedFg
    $ctxPct.MinWidth = 26; $ctxPct.TextAlignment = [System.Windows.TextAlignment]::Right
    $ctxPct.Margin = New-Object System.Windows.Thickness(3, 1, 0, 0)
    $ctxPct.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    $barTrack = New-Object System.Windows.Controls.Border
    $barTrack.Width = 34; $barTrack.Height = 4; $barTrack.CornerRadius = New-Object System.Windows.CornerRadius(2)
    $barTrack.Background = To-Brush $(if ($isLight) { "#180F172A" } else { "#24FFFFFF" })
    $barTrack.Margin = New-Object System.Windows.Thickness(6, 1, 0, 0)
    $barTrack.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    $barFill = New-Object System.Windows.Controls.Border
    $barFill.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
    $barFill.Width = 2; $barFill.Height = 4; $barFill.CornerRadius = New-Object System.Windows.CornerRadius(2)
    $barFill.Background = To-Brush "#22C55E"
    $barTrack.Child = $barFill

    $div1 = New-Object System.Windows.Controls.Border
    $div1.Width = 1; $div1.Height = 12; $div1.Background = $divBg
    $div1.Margin = New-Object System.Windows.Thickness(9, 0, 9, 0)
    $div1.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    [void]$ctxStack.Children.Add($ctxVal)
    [void]$ctxStack.Children.Add($ctxPct)
    [void]$ctxStack.Children.Add($barTrack)
    [void]$ctxStack.Children.Add($div1)
    [System.Windows.Controls.Grid]::SetColumn($ctxStack, 3)
    [void]$grid.Children.Add($ctxStack)

    # Col 4: Cache Hit + Divider
    $cacheStack = New-Object System.Windows.Controls.StackPanel
    $cacheStack.Orientation = [System.Windows.Controls.Orientation]::Horizontal
    $cacheStack.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    $cacheLbl = New-Object System.Windows.Controls.TextBlock
    $cacheLbl.Text = "缓存"; $cacheLbl.FontFamily = $fontMain; $cacheLbl.FontSize = 10.5
    $cacheLbl.Foreground = $mutedFg; $cacheLbl.Margin = New-Object System.Windows.Thickness(0, 0, 3, 0)
    $cacheLbl.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    $cacheVal = New-Object System.Windows.Controls.TextBlock
    $cacheVal.FontFamily = $fontMain; $cacheVal.FontSize = 12; $cacheVal.FontWeight = [System.Windows.FontWeights]::SemiBold
    $cacheVal.Foreground = To-Brush "#4ADE80"; $cacheVal.MinWidth = 30; $cacheVal.TextAlignment = [System.Windows.TextAlignment]::Right
    $cacheVal.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    $div2 = New-Object System.Windows.Controls.Border
    $div2.Width = 1; $div2.Height = 12; $div2.Background = $divBg
    $div2.Margin = New-Object System.Windows.Thickness(9, 0, 9, 0)
    $div2.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    [void]$cacheStack.Children.Add($cacheLbl)
    [void]$cacheStack.Children.Add($cacheVal)
    [void]$cacheStack.Children.Add($div2)
    [System.Windows.Controls.Grid]::SetColumn($cacheStack, 4)
    [void]$grid.Children.Add($cacheStack)

    # Col 5: Live Timer / Running Indicator
    $timerText = New-Object System.Windows.Controls.TextBlock
    $timerText.FontFamily = $fontMono
    $timerText.FontSize = 12
    $timerText.FontWeight = [System.Windows.FontWeights]::SemiBold
    $timerText.Foreground = $mainFg
    $timerText.MinWidth = 62
    $timerText.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    [System.Windows.Controls.Grid]::SetColumn($timerText, 5)
    [void]$grid.Children.Add($timerText)

    # Col 6: Action Alert Chip
    $alertChip = New-Object System.Windows.Controls.Border
    $alertChip.Visibility = [System.Windows.Visibility]::Collapsed
    $alertChip.CornerRadius = New-Object System.Windows.CornerRadius(7)
    $alertChip.Padding = New-Object System.Windows.Thickness(6, 1, 6, 1.5)
    $alertChip.Margin = New-Object System.Windows.Thickness(6, 0, 2, 0)
    $alertChip.BorderThickness = New-Object System.Windows.Thickness(1)
    $alertChip.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    $alertChipText = New-Object System.Windows.Controls.TextBlock
    $alertChipText.FontFamily = $fontMain; $alertChipText.FontSize = 10.5; $alertChipText.FontWeight = [System.Windows.FontWeights]::SemiBold
    $alertChip.Child = $alertChipText
    [System.Windows.Controls.Grid]::SetColumn($alertChip, 6)
    [void]$grid.Children.Add($alertChip)

    # Col 7: Subtle Dismiss '×' Button
    $closeBtn = New-Object System.Windows.Controls.Border
    $closeBtn.Width = 18; $closeBtn.Height = 18
    $closeBtn.CornerRadius = New-Object System.Windows.CornerRadius(9)
    $closeBtn.Margin = New-Object System.Windows.Thickness(5, 0, 0, 0)
    $closeBtn.Background = [System.Windows.Media.Brushes]::Transparent
    $closeBtn.Cursor = [System.Windows.Input.Cursors]::Hand
    $closeBtn.ToolTip = "隐藏此项目层（全部叉掉后自动隐身，有新对话/新消息或点桌面快捷方式即恢复）"
    $closeBtn.Tag = $convId

    $closeTxt = New-Object System.Windows.Controls.TextBlock
    $closeTxt.Text = "×"
    $closeTxt.FontFamily = $fontMain; $closeTxt.FontSize = 12.5
    $closeTxt.Foreground = To-Brush $(if ($isLight) { "#94A3B8" } else { "#64748B" })
    $closeTxt.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
    $closeTxt.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    $closeTxt.Margin = New-Object System.Windows.Thickness(0, -1, 0, 0)
    $closeBtn.Child = $closeTxt

    $closeBtn.Add_MouseEnter({
        param($sender, $ev)
        $sender.Background = To-Brush $(if ($prefs.theme -eq "light") { "#180F172A" } else { "#26FFFFFF" })
        $sender.Child.Foreground = To-Brush $(if ($prefs.theme -eq "light") { "#0F172A" } else { "#F8FAFC" })
    })
    $closeBtn.Add_MouseLeave({
        param($sender, $ev)
        $sender.Background = [System.Windows.Media.Brushes]::Transparent
        $sender.Child.Foreground = To-Brush $(if ($prefs.theme -eq "light") { "#94A3B8" } else { "#64748B" })
    })
    $closeBtn.Add_MouseLeftButtonDown({
        param($sender, $ev)
        $ev.Handled = $true
        try {
            $script:forceShowUntil = [DateTime]::MinValue
            $cid = [string]$sender.Tag
            $json = $script:webClient.DownloadString("$baseUrl/dismiss?id=$cid")
            $script:payload = $json | ConvertFrom-Json
            Update-UI
        } catch {}
    })
    [System.Windows.Controls.Grid]::SetColumn($closeBtn, 7)
    [void]$grid.Children.Add($closeBtn)

    $rowBorder.Child = $grid

    return [PSCustomObject]@{
        RowBorder     = $rowBorder
        Halo          = $halo
        Dot           = $dot
        TitleText     = $titleText
        ModelText     = $modelText
        CtxVal        = $ctxVal
        CtxPct        = $ctxPct
        BarFill       = $barFill
        CacheVal      = $cacheVal
        TimerText     = $timerText
        AlertChip     = $alertChip
        AlertChipText = $alertChipText
    }
}

function Rebuild-Stack([object[]]$items) {
    $rowsStack.Children.Clear()
    $script:rowMap = @{}
    $isLight = ($prefs.theme -eq "light")
    [object[]]$list = @(if ($null -ne $items) { $items })

    if ($list.Length -eq 0) {
        $emptyTxt = New-Object System.Windows.Controls.TextBlock
        $emptyTxt.Text = "🌙 待机 · 在反重力发送新消息后将自动分层显示"
        $emptyTxt.FontFamily = $fontMain
        $emptyTxt.FontSize = 12
        $emptyTxt.Foreground = To-Brush $(if ($isLight) { "#475569" } else { "#94A3B8" })
        $emptyTxt.Margin = New-Object System.Windows.Thickness(6, 4, 8, 4)
        [void]$rowsStack.Children.Add($emptyTxt)
        return
    }

    for ($i = 0; $i -lt $list.Length; $i++) {
        if ($i -gt 0) {
            $sep = New-Object System.Windows.Controls.Border
            $sep.Height = 1
            $sep.Background = To-Brush $(if ($isLight) { "#120F172A" } else { "#17FFFFFF" })
            $sep.Margin = New-Object System.Windows.Thickness(4, 2, 4, 2)
            [void]$rowsStack.Children.Add($sep)
        }
        $cid = [string]$list[$i].conversationId
        $refs = New-ProjectRow $cid
        $script:rowMap[$cid] = $refs
        [void]$rowsStack.Children.Add($refs.RowBorder)
    }
}

function Handle-SummonSignal {
    if (Test-Path $reloadPath) {
        try { Remove-Item $reloadPath -Force -ErrorAction SilentlyContinue } catch {}
        $timer.Stop()
        try { if (-not $nodeProc.HasExited) { $nodeProc.Kill() } } catch {}
        try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch {}
        $script:mutexReleased = $true
        try {
            if (Test-Path $launchVbsPath) {
                Start-Process -FilePath "wscript.exe" -ArgumentList "`"$launchVbsPath`" --auto" -WorkingDirectory $scriptDir
            }
        } catch {}
        $window.Close()
        return
    }

    if (-not (Test-Path $summonPath)) { return }
    $mode = "summon"
    try {
        $mode = (Get-Content -Path $summonPath -Raw -Encoding UTF8).Trim()
        Remove-Item $summonPath -Force -ErrorAction SilentlyContinue
    } catch {}

    if ($mode -eq "summon") {
        # User manually double-clicked Desktop shortcut: restore all hidden layers + pull to current cursor screen!
        try {
            $json = $script:webClient.DownloadString("$baseUrl/restore")
            $script:payload = $json | ConvertFrom-Json
            $script:lastFetched = [DateTime]::Now
        } catch {}
        $script:forceShowUntil = [DateTime]::Now.AddSeconds(20)
        $script:flashTicks = 5
        $window.Visibility = [System.Windows.Visibility]::Visible
        Move-ToCurrentScreenBottom
        Assert-WindowTopmost
        try { [void]$window.Activate() } catch {}
    } else {
        # Gentle background wake
        if (-not (Test-DipPointVisibleOnAnyScreen $window.Left $window.Top)) {
            Move-ToCurrentScreenBottom
        }
        if ($window.Visibility -eq [System.Windows.Visibility]::Visible) {
            Assert-WindowTopmost
        }
    }
}

function Update-UI {
    try {
        $now = [DateTime]::Now

        # 1. Check summon signal from Desktop shortcut immediately (500ms responsiveness)
        Handle-SummonSignal

        # 2. Prevent Win+D / Show Desktop from permanently minimizing borderless window
        if ($window.Visibility -eq [System.Windows.Visibility]::Visible -and $window.WindowState -eq [System.Windows.WindowState]::Minimized) {
            $window.WindowState = [System.Windows.WindowState]::Normal
            Assert-WindowTopmost
        }

        # 3. Auto-exit ~12s after Antigravity closes
        if (($now - $script:lastAgyCheck).TotalSeconds -ge 4.0) {
            $script:lastAgyCheck = $now
            $agyProcs = [System.Diagnostics.Process]::GetProcessesByName("Antigravity")
            if ($agyProcs -and $agyProcs.Length -gt 0) {
                $script:sawAntigravity = $true
                $script:agyMissingSince = $null
            } elseif ($prefs.autoExitWithAgy -and ($script:sawAntigravity -or ($AutoLaunch -and ($now - $script:startedAt).TotalSeconds -gt 25.0))) {
                if ($null -eq $script:agyMissingSince) {
                    $script:agyMissingSince = $now
                } elseif (($now - $script:agyMissingSince).TotalSeconds -ge 12.0) {
                    $window.Close()
                    return
                }
            }
        }

        # 4. Persist user-dragged position & update vertical anchor
        if (-not $script:repositioning -and $window.Visibility -eq [System.Windows.Visibility]::Visible) {
            if ([Math]::Abs($window.Left - $script:lastSavedLeft) -gt 1.0 -or [Math]::Abs($window.Top - $script:lastSavedTop) -gt 1.0) {
                $script:lastSavedLeft = [Math]::Round($window.Left, 1)
                $script:lastSavedTop  = [Math]::Round($window.Top, 1)
                if ($window.ActualHeight -gt 10) {
                    $script:anchorBottom = [Math]::Round($window.Top + $window.ActualHeight, 1)
                }
                $prefs.left = $script:lastSavedLeft
                $prefs.top  = $script:lastSavedTop
                $prefs.anchorBottom = $script:anchorBottom
                Save-Prefs
            }
        }

        # 5. Poll RAM endpoint every 1.2s
        if (($now - $script:lastFetched).TotalSeconds -ge 1.2) {
            $script:lastFetched = $now
            try {
                $json = $script:webClient.DownloadString($apiUrl)
                $script:payload = $json | ConvertFrom-Json
            } catch {}
        }

        [object[]]$items = @(if ($script:payload -and $null -ne $script:payload.items) { $script:payload.items })
        $hiddenCount = if ($script:payload -and $null -ne $script:payload.hiddenCount) { [int]$script:payload.hiddenCount } else { 0 }

        # 6. Auto-hide when all layers were dismissed ('×'); auto-reveal on new conversation/message!
        if ($items.Length -eq 0 -and $hiddenCount -gt 0 -and $now -ge $script:forceShowUntil) {
            if ($window.Visibility -ne [System.Windows.Visibility]::Hidden) {
                $window.Visibility = [System.Windows.Visibility]::Hidden
            }
            return
        } else {
            if ($window.Visibility -ne [System.Windows.Visibility]::Visible) {
                # Waking up from hidden state when new conversation/message arrives!
                if (-not (Test-DipPointVisibleOnAnyScreen $window.Left $window.Top)) {
                    Move-ToCurrentScreenBottom
                } else {
                    # Also bring to active cursor screen if it was previously hidden on another monitor
                    $curWa = Get-CursorWorkArea
                    $winWa = Get-WorkAreaForDipPoint ($window.Left + 80) ($window.Top + 20)
                    if ([Math]::Abs($curWa.Left - $winWa.Left) -gt 50) {
                        Move-ToCurrentScreenBottom
                    }
                }
                $window.Visibility = [System.Windows.Visibility]::Visible
                Assert-WindowTopmost
            }
        }

        $sig = if ($items.Length -gt 0) { ($items | ForEach-Object { [string]$_.conversationId }) -join "|" } else { "__empty__" }

        if ($sig -ne $script:currentSig -or $rowsStack.Children.Count -eq 0) {
            $script:currentSig = $sig
            Rebuild-Stack $items
        }

        $isLight = ($prefs.theme -eq "light")
        if ($items.Length -eq 0) {
            if ($script:flashTicks -gt 0) {
                $script:flashTicks--
                $cardBorder.BorderBrush = To-Brush "#CC38BDF8"
            } else {
                $cardBorder.BorderBrush = To-Brush $(if ($isLight) { "#220F172A" } else { "#2CFFFFFF" })
            }
            return
        }

        $nowUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $script:pulsePhase = -not $script:pulsePhase
        $anyUrgent = $false

        foreach ($it in $items) {
            $cid = [string]$it.conversationId
            $refs = $script:rowMap[$cid]
            if ($null -eq $refs) { continue }

            $used = [double]$it.usedTokens
            $limit = [double]$it.contextLimit
            $pct = [double]$it.pct
            $usedK = $used / 1000.0
            $isRunning = [bool]$it.isRunning
            $isAskUser = [bool]$it.isAskUser

            $refs.TitleText.Text = [string]$it.title
            $refs.ModelText.Text = [string]$it.modelShort
            $refs.CtxVal.Text = Format-Tokens $used
            $refs.CtxPct.Text = ("{0:F0}%" -f $pct)

            # Progress bar
            $fillW = [Math]::Max(2, [Math]::Min(34, [Math]::Round(34.0 * ($pct / 100.0))))
            $refs.BarFill.Width = $fillW
            if ($pct -ge 75)     { $refs.BarFill.Background = To-Brush "#EF4444" }
            elseif ($pct -ge 50) { $refs.BarFill.Background = To-Brush "#F59E0B" }
            elseif ($pct -ge 25) { $refs.BarFill.Background = To-Brush "#38BDF8" }
            else                 { $refs.BarFill.Background = To-Brush "#22C55E" }

            # Cache hit
            if ($null -ne $it.lastHitRatio) {
                $hit = [double]$it.lastHitRatio
                $refs.CacheVal.Text = ("{0:F0}%" -f $hit)
                if ($hit -ge 80)     { $refs.CacheVal.Foreground = To-Brush $(if ($isLight) { "#16A34A" } else { "#4ADE80" }) }
                elseif ($hit -ge 50) { $refs.CacheVal.Foreground = To-Brush $(if ($isLight) { "#D97706" } else { "#FBBF24" }) }
                else                 { $refs.CacheVal.Foreground = To-Brush $(if ($isLight) { "#DC2626" } else { "#F87171" }) }
            } else {
                $refs.CacheVal.Text = "--%"
            }

            $elapsedSec = [int][Math]::Max(0, [Math]::Floor(($nowUnixMs - [int64]$it.lastActivityMs) / 1000.0))
            $remainSec  = [int](240 - $elapsedSec)
            $runSec     = [int][Math]::Max(0, [Math]::Floor(($nowUnixMs - [int64]$it.runStartMs) / 1000.0))

            $statusSummary = ""
            $advice = ""

            if ($isRunning) {
                # AI is actively generating or running tools right now!
                $refs.TimerText.Text = "⚡ " + (Format-MmSs $runSec)
                $refs.TimerText.Foreground = To-Brush $(if ($isLight) { "#0284C7" } else { "#38BDF8" })
                $refs.Dot.Fill = To-Brush "#38BDF8"
                $refs.Halo.Fill = To-Brush $(if ($script:pulsePhase) { "#5538BDF8" } else { "#1E38BDF8" })
                $refs.RowBorder.Background = [System.Windows.Media.Brushes]::Transparent
                $refs.AlertChip.Visibility = [System.Windows.Visibility]::Collapsed
                $statusSummary = "⚡ AI 正在运行中（已执行 $(Format-MmSs $runSec)）"
                $advice = "AI 正在干活并自动续期缓存，等变绿倒数时再来看即可。"
            } elseif ($elapsedSec -lt 195) {
                # Safe window waiting for user (until 00:45 remaining)
                $refs.TimerText.Text = "⏱ " + (Format-MmSs $remainSec)
                $refs.TimerText.Foreground = To-Brush $(if ($isLight) { "#0F172A" } else { "#E2E8F0" })
                $refs.Dot.Fill = To-Brush "#22C55E"
                $refs.Halo.Fill = To-Brush "#3322C55E"
                $refs.RowBorder.Background = [System.Windows.Media.Brushes]::Transparent

                if ($isAskUser) {
                    $refs.AlertChip.Visibility = [System.Windows.Visibility]::Visible
                    $refs.AlertChip.Background = To-Brush "#2838BDF8"
                    $refs.AlertChip.BorderBrush = To-Brush "#7738BDF8"
                    $refs.AlertChipText.Foreground = To-Brush $(if ($isLight) { "#0369A1" } else { "#BAE6FD" })
                    $refs.AlertChipText.Text = "💬等你选"
                } elseif ($usedK -ge 250) {
                    $refs.AlertChip.Visibility = [System.Windows.Visibility]::Visible
                    $refs.AlertChip.Background = To-Brush $(if ($isLight) { "#20A855F7" } else { "#2EA855F7" })
                    $refs.AlertChip.BorderBrush = To-Brush "#77A855F7"
                    $refs.AlertChipText.Foreground = To-Brush $(if ($isLight) { "#6B21A8" } else { "#E9D5FF" })
                    $refs.AlertChipText.Text = "建议趁热压缩"
                } else {
                    $refs.AlertChip.Visibility = [System.Windows.Visibility]::Collapsed
                }

                $statusSummary = "✅ 已完成，等待你回复（缓存剩余 $(Format-MmSs $remainSec)）"
                if ($usedK -lt 50)       { $advice = "上下文较小（<50K），无需刻意保活。" }
                elseif ($usedK -lt 100)  { $advice = "缓存安全区。若准备离开超半小时，可趁热 /compact。" }
                elseif ($usedK -lt 250)  { $advice = "高上下文（≥100K）！建议4分钟内回复保活，离开前趁热 /compact。" }
                else                     { $advice = "超大上下文（≥250K，高危耗额区）！强烈建议趁现在热缓存发 /compact 瘦身。" }
            } elseif ($elapsedSec -lt 240) {
                # Final 45s warning before 4-minute cliff!
                $refs.TimerText.Text = "⏱ " + (Format-MmSs $remainSec)
                $refs.TimerText.Foreground = To-Brush $(if ($isLight) { "#D97706" } else { "#FBBF24" })
                $refs.Dot.Fill = To-Brush "#F59E0B"
                $refs.Halo.Fill = To-Brush $(if ($script:pulsePhase) { "#66F59E0B" } else { "#22F59E0B" })

                if ($usedK -ge $prefs.alertThresholdK) {
                    $anyUrgent = $true
                    $refs.RowBorder.Background = To-Brush $(if ($script:pulsePhase) { "#22F59E0B" } else { "#0DF59E0B" })
                    $refs.AlertChip.Visibility = [System.Windows.Visibility]::Visible
                    $refs.AlertChip.Background = To-Brush $(if ($isLight) { "#26F59E0B" } else { "#33F59E0B" })
                    $refs.AlertChip.BorderBrush = To-Brush "#88F59E0B"
                    $refs.AlertChipText.Foreground = To-Brush $(if ($isLight) { "#B45309" } else { "#FDE68A" })
                    $refs.AlertChipText.Text = if ($usedK -ge 250) { "高危快压缩" } elseif ($usedK -ge 100) { "快保活/压缩" } else { "尽快保活" }

                    $prevAlertMs = $script:alertedMap[$cid]
                    if ($prefs.soundEnabled -and $prevAlertMs -ne [int64]$it.lastActivityMs) {
                        $script:alertedMap[$cid] = [int64]$it.lastActivityMs
                        try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
                    }
                } else {
                    $refs.RowBorder.Background = [System.Windows.Media.Brushes]::Transparent
                    $refs.AlertChip.Visibility = [System.Windows.Visibility]::Collapsed
                }

                $statusSummary = "⚠️ 距 4 分钟缓存拐点仅剩 $(Format-MmSs $remainSec)！"
                $advice = "高上下文建议现在发一句「继续/好」保活，或立即趁热 /compact。"
            } else {
                # Empirically tuned cold threshold: 25m (1500s) for Carbon, 30m (1800s) for other models
                $coldLimitSec = if ([string]$it.modelShort -eq "Carbon") { 1500 } else { 1800 }
                $isCheap = [bool]$it.isCheapModel

                if ($elapsedSec -lt $coldLimitSec) {
                    # 4m ~ 25m/30m decay zone
                    $refs.TimerText.Text = "+" + (Format-MmSs $elapsedSec)
                    $refs.TimerText.Foreground = To-Brush $(if ($isLight) { "#DC2626" } else { "#F87171" })
                    $refs.Dot.Fill = To-Brush "#EF4444"
                    $refs.Halo.Fill = To-Brush "#2AEF4444"
                    $refs.RowBorder.Background = [System.Windows.Media.Brushes]::Transparent
                    $refs.AlertChip.Visibility = [System.Windows.Visibility]::Collapsed
                    $statusSummary = "已闲置 $(Format-MmSs $elapsedSec)（进入约50%概率衰减区）"
                    $advice = "已过4分钟拐点，若还要思考很久不必再特意保活。"
                } else {
                    # >= 25m/30m cold cache
                    $refs.TimerText.Text = "❄ 已凉"
                    $refs.TimerText.Foreground = To-Brush $(if ($isLight) { "#DC2626" } else { "#F87171" })
                    $refs.Dot.Fill = To-Brush "#EF4444"
                    $refs.Halo.Fill = To-Brush "#22EF4444"
                    $refs.RowBorder.Background = [System.Windows.Media.Brushes]::Transparent

                    if ($usedK -ge 100) {
                        $refs.AlertChip.Visibility = [System.Windows.Visibility]::Visible
                        $refs.AlertChip.Background = To-Brush $(if ($isLight) { "#20EF4444" } else { "#2EEF4444" })
                        $refs.AlertChip.BorderBrush = To-Brush "#77EF4444"
                        $refs.AlertChipText.Foreground = To-Brush $(if ($isLight) { "#B91C1C" } else { "#FCA5A5" })
                        if ($isCheap) {
                            $refs.AlertChipText.Text = "直接压缩"
                            $advice = "缓存大概率已凉。当前已是低价模型，建议直接点 /compact 压缩瘦身！"
                        } else {
                            $refs.AlertChipText.Text = "切H压缩"
                            $advice = "缓存大概率已凉。建议先切 H 模型点 /compact，压完再切回主力模型（省约60%）！"
                        }
                    } else {
                        $refs.AlertChip.Visibility = [System.Windows.Visibility]::Collapsed
                        $advice = "缓存已凉，但当前上下文不大（<100K），可直接继续。"
                    }
                    $statusSummary = ("已闲置 {0:F0} 分钟（缓存大概率已归零）" -f ($elapsedSec / 60.0))
                }
            }

            $sessHitStr = if ($null -ne $it.sessionHitRatio) { ("{0:F1}%" -f [double]$it.sessionHitRatio) } else { "--" }
            $refs.RowBorder.ToolTip = @"
项目：$($it.title)
状态：$statusSummary
模型：$($it.modelLabel)
上下文：$(Format-Tokens $used) / $(Format-Tokens $limit) ($("{0:F1}%" -f $pct))
本轮缓存命中：$($refs.CacheVal.Text)（会话累计：$sessHitStr）

💡 $advice
（左键任意处拖动整体面板 · 点右侧 × 可隐藏该层 · 右键打开设置）
"@
        }

        # Outer border glow: cyan flash on summon, amber pulse on 30s warning, otherwise normal
        if ($script:flashTicks -gt 0) {
            $script:flashTicks--
            $cardBorder.BorderBrush = To-Brush "#CC38BDF8"
        } elseif ($anyUrgent) {
            $cardBorder.BorderBrush = To-Brush $(if ($script:pulsePhase) { "#BBF59E0B" } else { "#55F59E0B" })
        } else {
            $cardBorder.BorderBrush = To-Brush $(if ($isLight) { "#220F172A" } else { "#2CFFFFFF" })
        }

    } catch {
        try {
            $errMsg = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $($_.Exception.Message) | $($_.InvocationInfo.PositionMessage)"
            Set-Content -Path $errLogPath -Value $errMsg -Encoding UTF8
        } catch {}
    }
}

# 500ms UI & Summon tick timer (snappy shortcut wakeup + smooth pulse)
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({ Update-UI })
$timer.Start()

# Initial immediate update
Update-UI

$window.Add_Loaded({
    Assert-WindowTopmost
})

# Clean shutdown
$window.Add_Closed({
    $timer.Stop()
    try {
        if (-not $nodeProc.HasExited) { $nodeProc.Kill() }
    } catch {}
    try { $script:webClient.Dispose() } catch {}
    try { Remove-Item $summonPath -Force -ErrorAction SilentlyContinue } catch {}
    if (-not $script:mutexReleased) {
        try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch {}
    }
})

[void]$window.ShowDialog()
