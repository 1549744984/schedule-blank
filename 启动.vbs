' 双击启动本机服务（8770）。黑窗口关掉 = 停止服务。
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = base
sh.Run "cmd /k python """ & base & "\server.py""", 1, False
