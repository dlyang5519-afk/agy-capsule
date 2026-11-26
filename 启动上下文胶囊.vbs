Option Explicit
Dim fso, sh, dir, ps1, extraArgs
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = dir & "\capsule.ps1"
extraArgs = ""
If WScript.Arguments.Count > 0 Then
    If LCase(WScript.Arguments(0)) = "--auto" Then
        extraArgs = " -AutoLaunch"
    End If
End If
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & ps1 & """" & extraArgs, 0, False
