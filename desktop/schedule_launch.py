"""日程与便签 · 启动引导（只干一件事：把桌面壳放到"没有控制台"的进程里跑起来）。

为什么不直接把快捷方式指向 pythonw.exe（2026-10-27 实测，两条都是死路）：
1. 基础解释器自带的 pythonw.exe 被本机「智能应用控制」强制模式拦，
   原文「应用程序控制策略已阻止此文件」；
2. `.venv\\Scripts\\pythonw.exe` 是 venv 的转发壳，它会去找同一个被拦的
   pythonw.exe，结果是能启动、立刻以退出码 101 结束，连一行代码都不执行
   （连 `pythonw.exe -c "写个文件"` 都写不出来）。

为什么不用 wscript + .vbs：本机把 wscript.exe 当 LOLBin 拦，.vbs 根本不跑。

为什么要有这个文件：python.exe 是控制台程序，从快捷方式启动会挂一个黑框。
本机默认终端是 Windows Terminal，那个黑框是独立窗口，`ShowWindow(SW_HIDE)`
藏不掉（伪控制台），所以只能换一种做法——由本文件起一个 CREATE_NO_WINDOW
的子进程去跑真正的桌面壳，自己立刻退出，黑框随父进程一起消失。
"""
import os
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000


def venv_home(root: str) -> str:
    """从 .venv/pyvenv.cfg 里读基础解释器所在目录，不写死路径（hermes 升级会换目录名）。"""
    cfg = os.path.join(root, ".venv", "pyvenv.cfg")
    if not os.path.isfile(cfg):
        return ""
    with open(cfg, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            key, _, value = line.partition("=")
            if key.strip().lower() == "home":
                return value.strip()
    return ""


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    python = os.path.join(root, ".venv", "Scripts", "python.exe")
    app = os.path.join(root, "desktop", "schedule_app.py")

    home = venv_home(root)
    base = os.path.join(home, "python.exe") if home else ""
    if not base or not os.path.isfile(base):
        base = python
    if not os.path.isfile(app):
        return 1

    env = dict(os.environ)
    site = os.path.join(root, ".venv", "Lib", "site-packages")
    old = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = site + (os.pathsep + old if old else "")

    subprocess.Popen(
        [base, app],
        cwd=root,
        env=env,
        creationflags=CREATE_NO_WINDOW,
        close_fds=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
