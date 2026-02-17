# Auto-dismiss "Unity is running as administrator" dialog
# Uses multiple methods: FindWindow + SendKeys
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
    
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const uint BM_CLICK = 0x00F5;
    public const int VK_TAB = 0x09;
    public const int VK_RETURN = 0x0D;
    public const int VK_RIGHT = 0x27;
}
"@

$maxWait = 120
$start = Get-Date
Add-Type -AssemblyName System.Windows.Forms

while (((Get-Date) - $start).TotalSeconds -lt $maxWait) {
    # Try multiple window title patterns
    $titles = @(
        "Unity is running as administrator.",
        "Unity is running as administrator"
    )
    
    foreach ($title in $titles) {
        $hwnd = [Win32]::FindWindow($null, $title)
        if ($hwnd -ne [IntPtr]::Zero) {
            "Found dialog: '$title' hwnd=$hwnd" | Out-File 'C:\worker\auto-dismiss.log' -Append
            
            # Method 1: Try to find and click the button
            $btn = [IntPtr]::Zero
            $child = [IntPtr]::Zero
            do {
                $child = [Win32]::FindWindowEx($hwnd, $child, 'Button', $null)
                if ($child -ne [IntPtr]::Zero) {
                    "Found button: $child" | Out-File 'C:\worker\auto-dismiss.log' -Append
                }
            } while ($child -ne [IntPtr]::Zero)
            
            # Method 2: SetForeground + Tab + Enter to select second button
            [Win32]::SetForegroundWindow($hwnd)
            Start-Sleep -Milliseconds 500
            
            # Send Tab to move to second button, then Enter
            [Win32]::PostMessage($hwnd, [Win32]::WM_KEYDOWN, [IntPtr][Win32]::VK_TAB, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 100
            [Win32]::PostMessage($hwnd, [Win32]::WM_KEYUP, [IntPtr][Win32]::VK_TAB, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 200
            [Win32]::PostMessage($hwnd, [Win32]::WM_KEYDOWN, [IntPtr][Win32]::VK_RETURN, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 100
            [Win32]::PostMessage($hwnd, [Win32]::WM_KEYUP, [IntPtr][Win32]::VK_RETURN, [IntPtr]::Zero)
            
            "Sent Tab+Enter at $(Get-Date -Format 'HH:mm:ss')" | Out-File 'C:\worker\auto-dismiss.log' -Append
            Start-Sleep -Seconds 2
            
            # Check if dialog is gone
            $check = [Win32]::FindWindow($null, $title)
            if ($check -eq [IntPtr]::Zero) {
                "Dialog dismissed!" | Out-File 'C:\worker\auto-dismiss.log' -Append
                exit 0
            } else {
                "Dialog still present, trying Enter on all buttons..." | Out-File 'C:\worker\auto-dismiss.log' -Append
                # Try clicking all buttons
                $child = [IntPtr]::Zero
                do {
                    $child = [Win32]::FindWindowEx($hwnd, $child, 'Button', $null)
                    if ($child -ne [IntPtr]::Zero) {
                        [Win32]::PostMessage($child, [Win32]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
                        Start-Sleep -Milliseconds 500
                    }
                } while ($child -ne [IntPtr]::Zero)
            }
        }
    }
    Start-Sleep -Seconds 2
}
"Timeout" | Out-File 'C:\worker\auto-dismiss.log' -Append
