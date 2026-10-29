# -*- coding: utf-8 -*-
"""日程与便签 · 单文件桌面应用入口。

一个原生 WebView2 窗口，内部自带本地 HTTP 数据服务：
- 不依赖外部 server.py 进程，关闭应用即停止内部服务。
- 直接读写原 Obsidian 日程目录和便签.json。
- 所有线上/离线同步仍由网页现有逻辑完成。
"""
import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request

APP_ID = "DongJinhe.ScheduleAndNotes"
APP_TITLE = "日程与便签"
DEFAULT_PORT = int(os.environ.get("SCHEDULE_APP_PORT", "8769"))
# 原生 WebView2 窗口短于这个时间就返回，视为“窗口自己挂了”，切 Edge 兜底
MIN_WEBVIEW_ALIVE = 20.0

# pywebview 的 WinForms 后端跑在 .NET Framework 上，而 pythonnet 3.x 默认去加载 coreclr，
# 结果是窗口建不出来，只报一句「Main window failed to start」，进程还赖着不退
# （2026-10-26 重打包时踩到：连点 12 次图标攒了 24 个僵尸进程）。
# 必须在 import webview / pythonnet 之前钉住，setdefault 保证外部仍可覆盖。
os.environ.setdefault("PYTHONNET_RUNTIME", "netfx")


def resource_path(*parts) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, *parts)


def hide_own_console():
    """保险丝：万一这个进程是被 python.exe 直接拉起来的，把黑框藏掉。

    正常情况下走不到这里——快捷方式指向 `desktop\\schedule_launch.py`，
    那边用 CREATE_NO_WINDOW 起的本进程，根本没有控制台。
    但直接跑 `python desktop\\schedule_app.py` 调试时会有，所以留着。

    为什么不能靠 pythonw：本机「智能应用控制」是强制模式，基础解释器的 pythonw.exe
    直接被拦（原文「应用程序控制策略已阻止此文件」）；venv 里的 pythonw.exe 是转发壳，
    能启动但立刻以退出码 101 结束，连一行 Python 代码都不执行（2026-10-27 实测）。
    wscript + .vbs 同样不通：本机把 wscript.exe 当 LOLBin 拦，.vbs 根本不跑。

    本机默认终端是 Windows Terminal，控制台是独立窗口，ShowWindow(SW_HIDE) 藏不掉，
    所以只能靠调度脚本从源头不建控制台。这里只在「控制台是给本进程单开的」时候动手，
    避免把用户正在用的终端窗口一起藏掉：挂在这个控制台上的进程名全是 python 才算单开。
    """
    if os.name != "nt":
        return
    try:
        kernel32 = ctypes.windll.kernel32
        user32 = ctypes.windll.user32
        hwnd = kernel32.GetConsoleWindow()
        if not hwnd:
            return
        buf = (ctypes.c_uint32 * 16)()
        count = kernel32.GetConsoleProcessList(buf, 16)
        if count <= 0 or count > 4:
            return
        ours = {"python.exe", "pythonw.exe"}
        for i in range(count):
            handle = kernel32.OpenProcess(0x1000, False, buf[i])  # QUERY_LIMITED_INFORMATION
            if not handle:
                return
            try:
                size = ctypes.c_ulong(512)
                path = ctypes.create_unicode_buffer(512)
                if not kernel32.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                    return
                if os.path.basename(path.value).lower() not in ours:
                    return
            finally:
                kernel32.CloseHandle(handle)
        user32.ShowWindow(hwnd, 0)  # SW_HIDE
    except Exception:
        pass


def local_appdata() -> str:
    return os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")


def app_dir() -> str:
    """exe 所在目录；开发运行时回项目根目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def web_dir() -> str:
    """静态文件目录：**优先 exe 旁边的 web/**，没有才用打包内置的那份。

    打包会把 web/ 塞进 exe 内部临时目录，导致界面永远停在打包那天——
    第 3 轮改完手机周视图，exe 窗口还是旧样式就是这个问题。
    优先读外部目录后，改 web/ 下的 css/js 只要刷新窗口就生效，不必重新打包；
    只有 server.py / 桌面壳本身变了才需要重打。
    用 index.html 是否存在来判断，避免指到一个空目录把界面搞成 404。
    """
    external = os.path.join(app_dir(), "web")
    if os.path.isfile(os.path.join(external, "index.html")):
        return external
    return resource_path("web")


def show_error(message: str):
    try:
        ctypes.windll.user32.MessageBoxW(None, message, APP_TITLE, 0x10)
    except Exception:
        pass


def enable_dpi_awareness():
    """必须在任何 WebView/Tk 窗口创建前执行，避免 125%/150% 缩放发糊。"""
    user32 = ctypes.windll.user32
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


_MUTEX_HANDLE = None


def already_running() -> bool:
    """单实例闸：已经有一个窗口在跑就直接退出，不再起第二个。

    旧版没有这道闸，反复点图标会攒下多个进程（2026-10-26 实测：连点 12 次 = 24 个进程）。
    它们共享同一个 WebView2 用户数据目录，第二个之后全都建不出窗口、只会赖着不走，
    还会锁住 exe 本身，导致更新时连文件都替换不了。
    """
    global _MUTEX_HANDLE
    if os.name != "nt":
        return False
    try:
        kernel32 = ctypes.windll.kernel32
        _MUTEX_HANDLE = kernel32.CreateMutexW(None, True, APP_ID + ".SingleInstance")
        return kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return False


def focus_existing_window() -> bool:
    """把已经开着的窗口提到前面。**返回是否真的找到了窗口。**

    原来这里只 ShowWindow，找不到窗口就什么都不做、也不给任何提示 →
    上一个实例如果已经变成「进程还在、窗口没了」的僵尸，用户点图标就永远没反应
    （2026-10-29 他实测「桌面端也打不开了」，就是这条）。
    所以改成返回布尔：找不到窗口，调用方要负责接管。
    """
    try:
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, APP_TITLE)
        if hwnd:
            # 关键：标题叫「日程与便签」的小窗口不止一个（实测有个 135×37、贴在 0,0 的怪窗口）。
            # 只按标题找就会一直「成功地」提到一个用户看不见的小窗，于是既不提窗也不放行。
            # 主窗口必须够大，否则一律当作不是它。
            rect = wintypes.RECT()
            user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect))
            if (rect.right - rect.left) < 400 or (rect.bottom - rect.top) < 300:
                return False
            # 僵尸实例会留下一个「有句柄但不可见」的窗口，FindWindow 找得到、用户看不见。
            # 所以必须先确认可见，不可见就强制显示；还是显示不出来就当僵尸处理。
            if not user32.IsWindowVisible(hwnd):
                user32.ShowWindow(hwnd, 5)  # SW_SHOW
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                time.sleep(0.2)
            if not user32.IsWindowVisible(hwnd):
                return False
            user32.SetForegroundWindow(hwnd)
            return True
    except Exception:
        pass
    return False


def kill_stale_instance() -> bool:
    """干掉「进程在、窗口没了」的上一个实例，然后把端口接管过来。

    pid 从 /api/ping 拿（server.py 已经回了 pid 字段），按 PID 精确终止，
    绝不用 taskkill /IM python.exe 那种一刀切（上一轮误杀过两个 python）。
    """
    for port in (8769,):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
                pid = json.load(r).get("pid")
        except Exception:
            continue
        if not pid or int(pid) == os.getpid():
            continue
        try:
            kernel32 = ctypes.windll.kernel32
            h = kernel32.OpenProcess(0x0001, False, int(pid))  # PROCESS_TERMINATE
            if not h:
                continue
            kernel32.TerminateProcess(h, 0)
            kernel32.CloseHandle(h)
            time.sleep(1.0)
            return True
        except Exception:
            continue
    return False


def handle_existing_instance() -> str:
    """启动第一步：先看 8769 上是不是挂着旧的自己。

    返回 "focused"（把旧窗口提到了，调用方直接退出）/ "killed"（收掉僵尸，自己接管）/ "none"。

    为什么不再靠互斥量做主判据：2026-10-29 连续两次「点图标没反应」，
    都是「进程还在、窗口没了」的僵尸——互斥量说有实例、FindWindowW 也找得到句柄，
    但那个窗口是不可见的，于是既不提窗也不放行。端口探测 + 可见性判断才靠得住。
    """
    try:
        with urllib.request.urlopen("http://127.0.0.1:8769/api/ping", timeout=1.2) as r:
            pid = json.load(r).get("pid")
    except Exception:
        return "none"          # 8769 没人应答：干干净净，直接起
    if not pid or int(pid) == os.getpid():
        return "none"
    # 有人应答：先看它有没有真窗口
    if focus_existing_window():
        return "focused"
    # 只有进程没有窗口（僵尸）→ 按 PID 精确收掉，绝不 taskkill /IM
    try:
        kernel32 = ctypes.windll.kernel32
        h = kernel32.OpenProcess(0x0001, False, int(pid))
        if h:
            kernel32.TerminateProcess(h, 0)
            kernel32.CloseHandle(h)
            time.sleep(1.0)
            return "killed"
    except Exception:
        pass
    return "none"


def start_server():
    """返回 (httpd, url, server 模块)。端口被占用时改用随机本地端口。"""
    sys.path.insert(0, resource_path("."))
    import server as schedule_server

    schedule_server.WEB = web_dir()
    last_error = None
    for port in (DEFAULT_PORT, free_port()):
        try:
            httpd = schedule_server.Server(("127.0.0.1", port), schedule_server.Handler)
            break
        except OSError as e:
            last_error = e
            httpd = None
    if not httpd:
        raise RuntimeError(f"无法启动本地数据服务：{last_error}")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    for _ in range(40):
        try:
            with urllib.request.urlopen(url + "/api/ping", timeout=0.5) as r:
                if r.status == 200:
                    # 开窗一律带一次性参数：Service Worker 按 URL 缓存首页，
                    # URL 每次不同就一定会走网络，改完 css/js 关窗再开必是新界面。
                    return httpd, url + "?boot=%d&client=desktop" % int(time.time() * 1000), schedule_server
        except Exception:
            time.sleep(0.1)
    httpd.shutdown()
    httpd.server_close()
    raise RuntimeError("本地数据服务没有在预期时间内启动")


def find_edge() -> str:
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ]
    for path in candidates:
        if "\\Microsoft\\Edge\\Application\\msedge.exe" in path and os.path.isfile(path):
            return path
    raise RuntimeError("没有找到 Microsoft Edge，无法打开应用窗口")


def _find_window_by_pid(pid: int) -> int:
    user32 = ctypes.windll.user32
    user32.EnumWindows.restype = ctypes.c_bool
    found = {"hwnd": 0}

    def _cb(hwnd, _lparam):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(ctypes.c_void_p(hwnd)):
            found["hwnd"] = hwnd
            return False
        return True

    user32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(_cb), 0)
    return found["hwnd"]


def _wait_edge_window(proc, timeout: float) -> int:
    """先按标题找，找不到再按 Edge 进程 PID 找（app 模式窗口标题可能被改）。"""
    user32 = ctypes.windll.user32
    user32.FindWindowW.restype = ctypes.c_void_p
    user32.IsWindow.argtypes = [ctypes.c_void_p]
    user32.IsWindow.restype = ctypes.c_bool
    deadline = time.time() + timeout
    while time.time() < deadline:
        hwnd = user32.FindWindowW(None, APP_TITLE)
        if hwnd:
            return int(hwnd)
        hwnd = _find_window_by_pid(proc.pid)
        if hwnd:
            return int(hwnd)
        if proc.poll() is not None:
            # Edge 可能把请求转交给已有实例后自己退出，再给窗口一点时间
            time.sleep(1.2)
            hwnd = user32.FindWindowW(None, APP_TITLE)
            return int(hwnd or 0)
        time.sleep(0.4)
    return 0


def launch_edge_fallback(url: str):
    """WebView2 不可用时，用 Edge 独立应用窗口（无地址栏、无标签页）。

    生命周期跟这个窗口绑定：窗口在，应用就在；窗口关，应用才退出。
    """
    profile = os.path.join(app_dir(), ".app-profile")
    os.makedirs(profile, exist_ok=True)
    proc = subprocess.Popen([
        find_edge(), f"--app={url}", f"--user-data-dir={profile}",
        "--no-first-run", "--disable-features=msEdgeFirstRunExperience",
        "--window-size=1280,820", "--window-position=120,80",
    ])
    hwnd = _wait_edge_window(proc, 45)
    if not hwnd:
        if proc.poll() is None:
            proc.wait()
        raise RuntimeError("Edge 独立窗口没有出现")
    # 只认「窗口还在且可见」：Edge 关掉 --app 窗口后，那个 HWND 往往仍然有效
    # （IsWindow 还是 True），老写法就一直等下去 → 进程不退、8769 一直占着，
    # 下次点图标就变成「没反应」的僵尸。连续两次看不到它才算真关掉。
    user32 = ctypes.windll.user32
    gone = 0
    while True:
        alive = bool(user32.IsWindow(ctypes.c_void_p(hwnd)))
        visible = bool(user32.IsWindowVisible(ctypes.c_void_p(hwnd)))
        if not alive or not visible:
            gone += 1
            if gone >= 2:
                break
        else:
            gone = 0
        time.sleep(0.6)


def smoke_test(httpd, url: str):
    out = os.environ.get("SCHEDULE_APP_SMOKE_OUT", "")
    data = {"ok": True, "url": url, "port": httpd.server_address[1]}
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    httpd.shutdown()
    httpd.server_close()
    return 0


def run_window(httpd, url: str):
    import webview

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception:
        pass
    storage = os.path.join(local_appdata(), "ScheduleAndNotes", "WebView")
    os.makedirs(storage, exist_ok=True)
    icon = resource_path("图标", "schedule.ico")
    smoke_out = os.environ.get("SCHEDULE_APP_WINDOW_SMOKE_OUT", "")
    window = webview.create_window(
        APP_TITLE, url, width=1280, height=820, min_size=(900, 600),
        background_color="#F5F3EE", text_select=True, hidden=bool(smoke_out),
    )

    ready_state = {"ready": None}

    def after_start():
        if not smoke_out:
            ready_state["ready"] = window.events._pywebviewready.wait(8)
            if not ready_state["ready"]:
                window.destroy()
            return
        result = {"ok": False}
        try:
            time.sleep(2)
            result = window.evaluate_js(
                "({title:document.title,"
                "hasMain:!!document.getElementById('main'),"
                "hasNotes:[...document.querySelectorAll('#view-switch button')].some(b=>b.dataset.view==='notes'),"
                "hasSync:!!document.getElementById('sync-info')})"
            )
            result["ok"] = bool(result.get("hasMain") and result.get("hasNotes"))
        except Exception as e:  # noqa: BLE001
            result["error"] = str(e)
        finally:
            with open(smoke_out, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False)
            window.destroy()

    started_at = time.time()
    try:
        webview.start(after_start, icon=icon, private_mode=False,
                      storage_path=storage, debug=False)
    except Exception as e:  # noqa: BLE001
        if smoke_out:
            with open(smoke_out, "w", encoding="utf-8") as f:
                json.dump({"ok": False, "error": str(e)}, f, ensure_ascii=False)
            return
        raise
    if smoke_out:
        return
    elapsed = time.time() - started_at
    if not ready_state["ready"]:
        raise RuntimeError("WebView2 窗口未就绪")
    # 页面已经加载完但进程这么快就返回，说明 WebView2 窗口自己挂了，
    # 不是用户关窗。这种情况要切到 Edge 独立窗口，别把应用一起带走。
    if elapsed < MIN_WEBVIEW_ALIVE:
        raise RuntimeError(f"WebView2 窗口提前退出（{elapsed:.1f}s）")


def main():
    hide_own_console()
    enable_dpi_awareness()
    smoke = "--smoke-test" in sys.argv or os.environ.get("SCHEDULE_APP_SMOKE") == "1"
    sticker_smoke_env = os.environ.get("SCHEDULE_APP_STICKERS_SMOKE_OUT", "")
    # 自检模式绝不能写进真实便签目录
    if (smoke or sticker_smoke_env) and not os.environ.get("SCHEDULE_NOTES_ROOT"):
        import tempfile
        os.environ["SCHEDULE_NOTES_ROOT"] = tempfile.mkdtemp(prefix="schedule-notes-smoke-")
    # 自检/贴纸自检不占闸，否则自检一跑就把正常窗口挡在外面
    if not (smoke or sticker_smoke_env):
        state = handle_existing_instance()
        if state == "focused":
            return 0
        # "killed" / "none" 都继续往下，自己把窗口开出来
    httpd, url, schedule_server = start_server()
    if smoke:
        raise SystemExit(smoke_test(httpd, url))

    stickers = None
    sticker_thread = None
    try:
        from sticker_layer import StickerBridge, StickerManagerThread
        sticker_thread = StickerManagerThread(headless=os.environ.get("STICKER_HEADLESS") == "1")
        sticker_thread.start()
        if sticker_thread.ready.wait(4) and not sticker_thread.error:
            schedule_server.STICKER_BRIDGE = StickerBridge(sticker_thread)
            stickers = sticker_thread
    except Exception:
        schedule_server.STICKER_BRIDGE = None

    sticker_smoke = os.environ.get("SCHEDULE_APP_STICKERS_SMOKE_OUT", "")
    if sticker_smoke:
        result = {"ok": False, "available": bool(schedule_server.STICKER_BRIDGE)}
        try:
            if schedule_server.STICKER_BRIDGE:
                note = schedule_server.api_save_note({
                    "title": "贴纸自检", "text": "贴纸自检正文",
                })["note"]
                schedule_server.STICKER_BRIDGE.toggle(note["id"])
                result["active"] = schedule_server.STICKER_BRIDGE.active_ids()
                result["ok"] = result["active"] == [note["id"]]
                schedule_server.STICKER_BRIDGE.thread.call("hide_all")
        except Exception as e:  # noqa: BLE001
            result["error"] = str(e)
        with open(sticker_smoke, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        schedule_server.STICKER_BRIDGE = None
        if stickers:
            stickers.stop()
        httpd.shutdown()
        httpd.server_close()
        return

    try:
        # 本机 msedgewebview2.exe 会崩溃（窗口空白 + "未响应"），所以默认直接用
        # Edge 独立应用窗口：同样没有地址栏/标签页，但稳定。
        # 想换回原生 WebView2：设 SCHEDULE_APP_ENGINE=webview
        engine = os.environ.get("SCHEDULE_APP_ENGINE", "edge").strip().lower()
        errors = []
        order = ("webview", "edge") if engine == "webview" else ("edge", "webview")
        for name in order:
            try:
                if name == "edge":
                    launch_edge_fallback(url)
                else:
                    run_window(httpd, url)
                return
            except Exception as e:  # noqa: BLE001
                errors.append(f"{name}: {e}")
        show_error(f"{APP_TITLE}启动失败：\n" + "\n".join(errors))
    finally:
        schedule_server.STICKER_BRIDGE = None
        if stickers:
            stickers.stop()
        elif sticker_thread:
            try:
                sticker_thread.join(timeout=1)
            except Exception:
                pass
        try:
            httpd.shutdown()
            httpd.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
