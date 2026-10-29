#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""日程系统 · 本地数据服务 (纯标准库, 无第三方依赖)

职责:
  1. 把 Obsidian 库里的 md 日程文件解析成 JSON 给网页用
  2. 把网页上的修改写回 md (只动 AUTO 标记区段, 不碰你手写的内容)
  3. 托管 web/ 目录下的日历界面

启动: 双击 启动.vbs  或  python server.py
访问: http://127.0.0.1:8770   (手机: http://<本机局域网IP>:8770)
"""
import http.server
import base64
import gzip
import glob
import hmac
import json
import os
import re
import secrets
import socketserver
import datetime
import socket
import threading
import urllib.parse
import time
import hashlib
import ssl

import notes_store

BASE = os.path.dirname(os.path.abspath(__file__))

# 版本号的唯一出处：HTTP 头与 /api/ping 都从这里取，前端只负责显示、不许硬编码
# （他原话「所谓最新版，我根本没看到是什么」——界面里必须看得见版本，且不能有第二份）
APP_VERSION = "0.3.9"
APP_BUILD = "2026-10-29"
# 进程启动时刻：模块加载时记一次。前端拿它判断「服务端这份代码是什么时候加载的」，
# 桌面壳和网页端是两个进程，各跑各的，这个值能让「改了没生效」一眼看出来。
BOOT_AT = time.time()

# 白板版：默认指向仓库内的 数据/日程，换电脑、换路径都不用改代码
VAULT = os.environ.get("SCHEDULE_VAULT") or os.path.join(BASE, "数据", "日程")
WEB = os.path.join(BASE, "web")
PORT = int(os.environ.get("SCHEDULE_PORT", "8770"))
HTTPS_PORT = int(os.environ.get("SCHEDULE_HTTPS_PORT", "8771"))
CERT_DIR = os.path.join(BASE, "certs")
HTTPS_CERT = os.path.join(CERT_DIR, "server.crt")
HTTPS_KEY = os.path.join(CERT_DIR, "server.key")
CA_CERT = os.path.join(CERT_DIR, "ca.crt")

# 主程序进程内的贴纸浮窗桥；独立 server.py 启动，或手机访问时保持 None。
STICKER_BRIDGE = None

LOCK = threading.Lock()


# ---------------------------------------------------------------- 认证

AUTH_FILE = os.path.join(BASE, "auth.json")
PWD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def load_auth() -> dict:
    """每次现读，改 auth.json 后不用重启"""
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            return cfg if isinstance(cfg, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def ensure_auth() -> dict:
    """首次启动生成随机密码"""
    cfg = load_auth()
    if cfg.get("password"):
        return cfg
    cfg = {
        "user": cfg.get("user") or "local",
        "password": "".join(secrets.choice(PWD_ALPHABET) for _ in range(8)),
    }
    try:
        with open(AUTH_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return cfg


TOKEN_FILE = os.path.join(BASE, "auth-tokens.json")
TOKEN_TTL = 30 * 24 * 3600
TOKEN_REFRESH_GRACE = 30 * 24 * 3600
AUTH_LOCK = threading.Lock()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _read_tokens() -> dict:
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _write_tokens(tokens: dict):
    tmp = TOKEN_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(tokens, f, ensure_ascii=False, indent=2)
    os.replace(tmp, TOKEN_FILE)


def _new_token_locked() -> dict:
    now = int(time.time())
    token = secrets.token_urlsafe(32)
    tokens = _read_tokens()
    tokens = {k: v for k, v in tokens.items() if int(v.get("refreshBefore", 0)) > now}
    rec = {"expiresAt": now + TOKEN_TTL, "refreshBefore": now + TOKEN_TTL + TOKEN_REFRESH_GRACE}
    tokens[_token_hash(token)] = rec
    _write_tokens(tokens)
    return {"ok": True, "token": token, "expiresAt": rec["expiresAt"] * 1000,
            "refreshBefore": rec["refreshBefore"] * 1000}


def api_auth_login(payload: dict) -> dict:
    cfg = load_auth()
    user = str(payload.get("user") or "")
    password = str(payload.get("password") or "")
    if not cfg.get("password"):
        raise ValueError("服务还没有设置登录凭据")
    valid = (hmac.compare_digest(user.encode(), str(cfg.get("user", "")).encode())
             and hmac.compare_digest(password.encode(), str(cfg["password"]).encode()))
    if not valid:
        raise ValueError("用户名或密码错误")
    with AUTH_LOCK:
        return _new_token_locked()


def _token_record(token: str, allow_expired: bool = False):
    if not token:
        return None
    now = int(time.time())
    rec = _read_tokens().get(_token_hash(token))
    if not rec:
        return None
    if int(rec.get("refreshBefore", 0)) <= now:
        return None
    if not allow_expired and int(rec.get("expiresAt", 0)) <= now:
        return None
    return rec


def auth_token_valid(token: str) -> bool:
    with AUTH_LOCK:
        return _token_record(token) is not None


def api_auth_refresh(token: str) -> dict:
    with AUTH_LOCK:
        rec = _token_record(token, allow_expired=True)
        if not rec:
            raise ValueError("登录已失效，请重新登录")
        old = _read_tokens()
        old.pop(_token_hash(token), None)
        _write_tokens(old)
        return _new_token_locked()

# ---------------------------------------------------------------- 路径

def year_dir() -> str:
    p = os.path.join(VAULT, str(datetime.date.today().year))
    os.makedirs(p, exist_ok=True)
    return p


def day_path(d: str) -> str:
    return os.path.join(VAULT, d[:4], d + ".md")


def month_path(ym: str) -> str:
    return os.path.join(VAULT, ym[:4], ym + ".md")


def week_path(iso: str) -> str:
    return os.path.join(VAULT, iso[:4], iso + ".md")


NOTES_FILE = os.path.join(VAULT, "便签.json")  # 旧版单一 json，只作历史文件保留，不再读写

# ---------------------------------------------------------------- 解析

EVENT_RE = re.compile(r"^- (\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})\s+(.+)$")
ALLDAY_RE = re.compile(r"^- 全天\s+(.+)$")
TODO_RE = re.compile(r"^- \[( |x|X)\]\s*(.+)$")
TAG_RE = re.compile(r"#([^\s#]+)")
# 地点从 @ 一直到行尾的 # 或结束，**允许中间有空格**（「@东盟 G-4012」是合法地址）。
# 原写法 [^\s#@]+ 一遇空格就截断，只剩「东盟」。
LOC_RE = re.compile(r"@([^#@\n]+)")


def split_tags(text: str):
    tags = TAG_RE.findall(text)
    title = TAG_RE.sub("", text).strip()
    return title, tags


def split_meta(text: str):
    """从事件正文里剥出 `#标签` 与 `@地点`，剩下的当标题。

    `@地点` 是可选的，旧数据没有这一段，解析出来是空串，写回时也不追加，
    所以老文件不需要迁移。
    """
    tags = TAG_RE.findall(text)
    locs = LOC_RE.findall(text)
    title = LOC_RE.sub("", TAG_RE.sub("", text)).strip()
    return title, tags, (locs[0].strip() if locs else "")


def split_priority(title: str):
    body = (title or "").strip()
    if body.startswith("! "):
        return body[2:].strip(), "high"
    return body, "normal"


def parse_day(date: str, text: str) -> dict:
    events, todos = [], []
    section = None
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("<!-- AUTO:events:start"):
            section = "events"
            continue
        if s.startswith("<!-- AUTO:events:end"):
            section = None
            continue
        if s.startswith("<!-- AUTO:todos:start"):
            section = "todos"
            continue
        if s.startswith("<!-- AUTO:todos:end"):
            section = None
            continue
        if section == "events":
            m = EVENT_RE.match(s)
            if m:
                title, tags, loc = split_meta(m.group(3))
                title, priority = split_priority(title)
                if title:
                    events.append({"start": m.group(1).zfill(5),
                                   "end": m.group(2).zfill(5),
                                   "title": title, "tags": tags, "priority": priority,
                                   "location": loc, "allday": False})
                continue
            m = ALLDAY_RE.match(s)
            if m:
                title, tags, loc = split_meta(m.group(1))
                title, priority = split_priority(title)
                if title:
                    events.append({"start": "", "end": "", "title": title,
                                   "tags": tags, "priority": priority, "location": loc, "allday": True})
                continue
        elif section == "todos":
            m = TODO_RE.match(s)
            if m:
                body, priority = split_priority(m.group(2))
                todos.append({"done": m.group(1).lower() == "x", "text": body, "priority": priority})
    return {"date": date, "events": events, "todos": todos, "note": parse_note(text)}


def parse_note(text: str) -> str:
    m = re.search(r"(?ms)^## 备注[^\n]*\n(.*?)(?=^## |\Z)", text)
    return m.group(1).strip("\n") if m else ""


def replace_note(text: str, note: str) -> str:
    note = (note or "").replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    block = "## 备注\n" + (note + "\n" if note else "")
    pattern = re.compile(r"(?ms)^## 备注[^\n]*\n.*?(?=^## |\Z)")
    if pattern.search(text):
        return pattern.sub(lambda _: block, text, count=1)
    return text.rstrip("\n") + "\n\n" + block


def parse_list_section(text: str, heading_kw: str) -> list:
    """读取 `## 本月目标` / `## 本周重点` 之类小节下的 checklist 行"""
    out, inside = [], False
    for raw in text.splitlines():
        s = raw.strip()
        if s.startswith("## "):
            inside = heading_kw in s
            continue
        if not inside:
            continue
        m = TODO_RE.match(s)
        if m:
            body = m.group(2).strip()
            day = None
            dm = re.search(r"@(\d{4}-\d{2}-\d{2})", body)
            if dm:
                day = dm.group(1)
                body = body.replace(dm.group(0), "").strip()
            out.append({"done": m.group(1).lower() == "x", "text": body, "date": day})
    return out


def parse_month(ym: str, text: str) -> dict:
    return {"ym": ym,
            "goals": parse_list_section(text, "本月目标"),
            "milestones": parse_list_section(text, "关键节点")}


def parse_week(iso: str, text: str) -> dict:
    return {"iso": iso, "goals": parse_list_section(text, "本周重点")}


# ---------------------------------------------------------------- 写回

def render_events(events: list) -> list:
    rows = []
    for e in sorted(events, key=lambda x: ("99:99" if _is_allday(x) else (x.get("start") or ""))):
        title = (e.get("title") or "").strip()
        if not title:
            continue
        tags = "".join(" #" + str(t).lstrip("#") for t in (e.get("tags") or []) if str(t).strip())
        loc = (e.get("location") or "").strip()  # 不再吃空格：「东盟 G-4012」要原样写回
        loc = f" @{loc}" if loc else ""
        priority = "! " if e.get("priority") == "high" else ""
        if _is_allday(e):
            rows.append(f"- 全天 {priority}{title}{loc}{tags}")
        else:
            rows.append(f"- {(e.get('start') or '').strip()}-{(e.get('end') or '').strip()} "
                        f"{priority}{title}{loc}{tags}")
    return rows


def _is_allday(e: dict) -> bool:
    """没有起止时间的事件按「全天」处理。

    原来缺时间会落成 `00:00-00:00`，回来解析成零长度事件，周/日视图里画不出来。
    AI 导入时「只有标题、没有时间」是最常见的情况，必须自动落到全天。
    """
    if e.get("allday"):
        return True
    return not (e.get("start") or "").strip() or not (e.get("end") or "").strip()


def render_todos(todos: list) -> list:
    return [f"- [{'x' if t.get('done') else ' '}] {'! ' if t.get('priority') == 'high' else ''}{(t.get('text') or '').strip()}"
            for t in todos if (t.get("text") or "").strip()]


def replace_section(text: str, name: str, lines: list) -> str:
    start_tag = f"<!-- AUTO:{name}:start -->"
    end_tag = f"<!-- AUTO:{name}:end -->"
    body = "\n".join(lines)
    block = start_tag + ("\n" + body if body else "") + "\n" + end_tag
    if start_tag in text and end_tag in text:
        i = text.index(start_tag)
        j = text.index(end_tag) + len(end_tag)
        return text[:i] + block + text[j:]
    return text.rstrip("\n") + "\n\n" + block + "\n"


WEEKDAY_CN = "一二三四五六日"


def day_template(date: str) -> str:
    d = datetime.date.fromisoformat(date)
    return (f"---\ndate: {date}\ntype: 日计划\ntags:\n  - 日程\n---\n\n"
            f"# {date} 周{WEEKDAY_CN[d.weekday()]}\n\n"
            "## 时间块\n<!-- AUTO:events:start -->\n<!-- AUTO:events:end -->\n\n"
            "## 待办\n<!-- AUTO:todos:start -->\n<!-- AUTO:todos:end -->\n\n"
            "## 备注\n")


def safe_inside(root: str, target: str) -> bool:
    try:
        return os.path.commonpath([os.path.realpath(root), os.path.realpath(target)]) == os.path.realpath(root)
    except ValueError:
        return False


def read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""
    except UnicodeDecodeError:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            return f.read()


BACKUP_ROOT = os.environ.get("SCHEDULE_BACKUP") or os.path.join(BASE, "备份")


def backup_before_write(path: str) -> None:
    """写盘前把「现在这份」复制到 日程备份 的 _最近一次 目录，同名覆盖。

    一天改十次也只留一份，永远是「上一次的状态」，误删 / 写错当场能捞回来。
    **失败绝不影响保存**——备份是保险，不是前提。
    """
    try:
        if not os.path.isfile(path):
            return
        roots = ((VAULT, "日程"), (getattr(notes_store, "ROOT", None), "便签"))
        rel = None
        for root, tag in roots:
            if root and os.path.abspath(path).lower().startswith(os.path.abspath(root).lower()):
                rel = os.path.join(tag, os.path.relpath(path, root))
                break
        if rel is None:
            return
        dest = os.path.join(BACKUP_ROOT, "_最近一次", rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(path, "rb") as src, open(dest + ".tmp", "wb") as dst:
            dst.write(src.read())
        os.replace(dest + ".tmp", dest)
    except Exception as e:  # noqa: BLE001
        print(f"[backup] 跳过（不影响保存）：{e}")


def write_text(path: str, text: str) -> None:
    backup_before_write(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def iso_week(d: datetime.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def api_search(q: str) -> dict:
    """模糊搜索：日期数字（1022 / 10-22）或正文关键词"""
    q = (q or "").strip()
    if not q or not os.path.isdir(VAULT):
        return {"q": q, "results": []}
    ql = q.lower().replace(" ", "")
    digits = re.sub(r"\D", "", ql)

    out = []
    for path in sorted(glob.glob(os.path.join(VAULT, "**", "*.md"), recursive=True)):
        base = os.path.basename(path)
        name = os.path.splitext(base)[0]
        if not re.fullmatch(r"\d{4}(-\d{2}-\d{2}|-\d{2}|-W\d{2})", name):
            continue
        kind = "day" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", name) else (
            "week" if "W" in name else "month")
        text = read_text(path)

        compact = name.replace("-", "").lower()
        date_hit = len(digits) >= 3 and digits in compact

        body = text.split("---", 2)[-1] if text.lstrip().startswith("---") else text
        hits = []
        for line in body.splitlines():
            s = line.strip()
            if not s or s.startswith("#") or s.startswith("<!--"):
                continue
            if ql in s.lower().replace(" ", ""):
                hit = re.sub(r"^\[( |x|X)\]\s*", "", s.lstrip("- ")).strip()
                hits.append(hit[:70])
        if not hits and not date_hit:
            continue
        out.append({"kind": kind, "id": name, "hits": hits[:3], "n": len(hits), "_d": date_hit})

    out.sort(key=lambda x: (not x["_d"], x["id"]))
    for o in out:
        o.pop("_d", None)
    return {"q": q, "results": out[:25]}


def daterange(start: datetime.date, end: datetime.date):
    cur = start
    while cur <= end:
        yield cur
        cur += datetime.timedelta(days=1)


def iso_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_notes() -> list:
    """兼容旧调用：返回当前目录下的便签列表。"""
    return notes_store.scan()


def active_notes(items: list) -> list:
    return [n for n in items if not n.get("deleted") and not n.get("archived")]


def api_notes() -> dict:
    """便签 = vault 里的 md 文件；同时返回文件夹树和旧 json 迁移提示。"""
    with LOCK:
        return notes_store.list_notes()


def api_save_note(payload: dict) -> dict:
    with LOCK:
        saved = notes_store.save(payload)
        merged = saved.pop("merged", None)
        data = notes_store.list_notes()
    out = {"ok": True, "note": saved, "notes": data["notes"], "tree": data["tree"]}
    if merged:
        out["merged"] = merged
    return out


def api_note_folder(payload: dict) -> dict:
    """新建 / 重命名 / 删除（仅空）文件夹。"""
    action = str(payload.get("action") or "create")
    with LOCK:
        if action == "create":
            notes_store.folder_create(str(payload.get("path") or ""))
        elif action == "rename":
            notes_store.folder_rename(str(payload.get("path") or ""),
                                      str(payload.get("newPath") or ""))
        elif action == "delete":
            notes_store.folder_delete(str(payload.get("path") or ""))
        else:
            raise ValueError("action 只能是 create / rename / delete")
        data = notes_store.list_notes()
    return {"ok": True, "notes": data["notes"], "tree": data["tree"]}


def api_note_move(payload: dict) -> dict:
    with LOCK:
        saved = notes_store.move(str(payload.get("id") or ""), str(payload.get("folder") or ""))
        merged = saved.pop("merged", None)
        data = notes_store.list_notes()
    out = {"ok": True, "note": saved, "notes": data["notes"], "tree": data["tree"]}
    if merged:
        out["merged"] = merged
    return out


def api_note_archive(payload: dict) -> dict:
    with LOCK:
        saved = notes_store.archive(str(payload.get("id") or ""))
        merged = saved.pop("merged", None)
        data = notes_store.list_notes()
    out = {"ok": True, "note": saved, "notes": data["notes"], "tree": data["tree"]}
    if merged:
        out["merged"] = merged
    return out


def api_notes_settings(payload: dict) -> dict:
    if payload.get("root"):
        with LOCK:
            notes_store.set_notes_root(str(payload.get("root")))
    data = api_notes()
    return data


# ---------------------------------------------------------------- API


def file_updated_at(path: str) -> int:
    try:
        return int(os.path.getmtime(path) * 1000)
    except OSError:
        return 0


def day_with_meta(date: str, path: str, text: str) -> dict:
    day = parse_day(date, text)
    day["updatedAt"] = file_updated_at(path)
    return day


def api_range(qs: dict) -> dict:
    today = datetime.date.today()
    try:
        start = datetime.date.fromisoformat(qs.get("from", today.isoformat()))
        end = datetime.date.fromisoformat(qs.get("to", start.isoformat()))
    except ValueError:
        start = end = today
    if end < start:
        start, end = end, start
    if (end - start).days > 400:
        end = start + datetime.timedelta(days=400)

    days = {}
    for d in daterange(start, end):
        ds = d.isoformat()
        path = day_path(ds)
        text = read_text(path)
        days[ds] = day_with_meta(ds, path, text) if text else {"date": ds, "events": [], "todos": [], "updatedAt": 0}

    months, weeks = {}, {}
    for d in daterange(start, end):
        ym = d.strftime("%Y-%m")
        if ym not in months:
            t = read_text(month_path(ym))
            if t:
                months[ym] = parse_month(ym, t)
        iso = iso_week(d)
        if iso not in weeks:
            t = read_text(week_path(iso))
            if t:
                weeks[iso] = parse_week(iso, t)

    return {"from": start.isoformat(), "to": end.isoformat(),
            "today": today.isoformat(), "days": days,
            "months": months, "weeks": weeks}


def _minute(hhmm: str) -> int:
    m = re.match(r"^(\d{1,2}):(\d{2})$", (hhmm or "").strip())
    return int(m.group(1)) * 60 + int(m.group(2)) if m else -1


def _overlaps(a: dict, b: dict) -> bool:
    """两个都有起止时间且时间交叉才算冲突；全天事项不参与。"""
    if _is_allday(a) or _is_allday(b):
        return False
    a0, a1 = _minute(a.get("start")), _minute(a.get("end"))
    b0, b1 = _minute(b.get("start")), _minute(b.get("end"))
    if min(a0, a1, b0, b1) < 0:
        return False
    return a0 < b1 and b0 < a1


def _event_key(e: dict):
    when = "全天" if _is_allday(e) else f"{(e.get('start') or '').strip()}-{(e.get('end') or '').strip()}"
    return (when, (e.get("title") or "").strip(), (e.get("location") or "").strip())


def _dedupe_events(items: list) -> list:
    seen, out = set(), []
    for e in items:
        k = _event_key(e)
        if not k[1] or k in seen:
            continue
        seen.add(k)
        out.append(e)
    return out


def _dedupe_todos(items: list) -> list:
    seen, out = set(), []
    for t in items:
        k = ((t.get("text") or "").strip(), bool(t.get("done")))
        if not k[0] or k in seen:
            continue
        seen.add(k)
        out.append(t)
    return out


def _expand_spans(date: str, events: list):
    """跨天事件展开：`{"title": "实习", "end_date": "2026-11-04", "allday": true}`

    引擎是一天一个文件，没有跨天概念。所以在**写入这一层**把跨天事件拆成每天一条：
    当天那条留在本次写入里，后面几天由调用方递归写入。md 数据模型完全不变。
    返回 (extra_days, events_for_this_day)。
    """
    try:
        d1 = datetime.date.fromisoformat(date)
    except ValueError:
        return {}, events
    extra, keep = {}, []
    for e in events:
        end = str(e.get("end_date") or "").strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end):
            keep.append(e)
            continue
        try:
            d2 = datetime.date.fromisoformat(end)
        except ValueError:
            keep.append(e)
            continue
        if d2 <= d1:
            keep.append({k: v for k, v in e.items() if k != "end_date"})
            continue
        base = {k: v for k, v in e.items() if k != "end_date"}
        base["allday"] = True
        keep.append(base)
        for i in range(1, (d2 - d1).days + 1):
            extra.setdefault((d1 + datetime.timedelta(days=i)).isoformat(), []).append(dict(base))
    return extra, keep


def api_save_day(payload: dict) -> dict:
    date = (payload.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("date 必须是 YYYY-MM-DD")
    path = day_path(date)
    client_updated = int(payload.get("updatedAt") or 0)
    # 默认 append：AI 漏传 mode 时也不会把当天已有日程冲掉；网页保存会显式传 replace
    mode = (payload.get("mode") or "append").strip().lower()
    if mode in ("merge", "add"):
        mode = "append"
    if mode not in ("replace", "append"):
        raise ValueError("mode 只能是 replace 或 append")
    # 跨天事件先展开成本次要写的当天 + 之后几天的清单
    extra_days, events = _expand_spans(date, payload.get("events") or [])
    payload = dict(payload, events=events)
    with LOCK:
        text = read_text(path)
        server_updated = file_updated_at(path) if text else 0
        # 2026-10-29 F：以桌面端为准。桌面端写进来就无条件覆盖；
        # 手机端碰上「服务端更新」仍然让出，由前端提示「已用桌面端的版本」。
        if client_updated and server_updated > client_updated and payload.get("_client") != "desktop":
            return {"ok": True, "merged": "server-newer", "day": day_with_meta(date, path, text)}
        if not text:
            text = day_template(date)
        events = payload.get("events") or []
        todos = payload.get("todos") or []
        conflicts = []
        if mode == "append":
            # AI 导入用这条路径：读出现有内容再往后加，绝不覆盖用户已有日程
            cur = parse_day(date, text)
            old_events = cur.get("events") or []
            for e in events:
                for o in old_events:
                    if _overlaps(e, o):
                        conflicts.append({
                            "date": date,
                            "new": (e.get("title") or "").strip(),
                            "new_time": f"{(e.get('start') or '').strip()}-{(e.get('end') or '').strip()}",
                            "existing": (o.get("title") or "").strip(),
                            "existing_time": f"{(o.get('start') or '').strip()}-{(o.get('end') or '').strip()}",
                        })
            events = _dedupe_events(old_events + events)
            todos = _dedupe_todos((cur.get("todos") or []) + todos)
        text = replace_section(text, "events", render_events(events))
        text = replace_section(text, "todos", render_todos(todos))
        if "note" in payload:
            note = payload.get("note") or ""
            if not isinstance(note, str) or len(note) > 50000:
                raise ValueError("备注必须是 50000 字以内的文本")
            text = replace_note(text, note)
        write_text(path, text)
    result = {"ok": True, "path": path, "mode": mode, "day": day_with_meta(date, path, text)}
    if conflicts:
        result["conflicts"] = conflicts
    if extra_days:
        # 跨天的后几天一律按 append 写，绝不重置那几天已有的日程
        for d in sorted(extra_days):
            api_save_day({"date": d, "events": extra_days[d], "mode": "append"})
        result["span_days"] = [date] + sorted(extra_days)
    return result


def api_save_text(payload: dict) -> dict:
    """供 AI / 外部脚本整文件写入 md (仅允许 VAULT 内)"""
    rel = (payload.get("path") or "").replace("\\", "/").lstrip("/")
    target = os.path.normpath(os.path.join(VAULT, rel))
    if not safe_inside(VAULT, target):
        raise ValueError("路径越界")
    if not target.endswith(".md"):
        raise ValueError("只允许 .md")
    with LOCK:
        write_text(target, payload.get("content") or "")
    return {"ok": True, "path": target}


def api_toggle_goal(payload: dict) -> dict:
    """勾掉 / 取消一条「本周重点」或「本月目标」。

    只改那一行的 `- [ ]` / `- [x]` 标记，不重排、不重新渲染整个文件，
    所以用户在同文件里手写的备注不受影响。
    """
    kind = (payload.get("kind") or "").strip()
    key = (payload.get("key") or "").strip()
    try:
        idx = int(payload.get("index", -1))
    except (TypeError, ValueError):
        idx = -1
    if kind == "week":
        path, heading = week_path(key), "本周重点"
    elif kind == "month":
        path, heading = month_path(key), "本月目标"
    else:
        return {"ok": False, "error": "kind 只能是 week 或 month"}
    if idx < 0:
        return {"ok": False, "error": "index 无效"}
    if not os.path.isfile(path):
        return {"ok": False, "error": "文件不存在：" + path}

    with LOCK:
        text = read_text(path)
        lines = text.splitlines()
        inside, n = False, 0
        for i, raw in enumerate(lines):
            s = raw.strip()
            if s.startswith("## "):
                inside = heading in s
                continue
            if not inside or not TODO_RE.match(s):
                continue
            if n == idx:
                done = s[3:4].lower() == "x"
                if done:
                    lines[i] = raw.replace("[x]", "[ ]").replace("[X]", "[ ]")
                else:
                    lines[i] = raw.replace("[ ]", "[x]")
                out = "\n".join(lines)
                if text.endswith("\n"):
                    out += "\n"
                write_text(path, out)
                return {"ok": True, "done": not done}
            n += 1
    return {"ok": False, "error": f"没找到第 {idx} 条目标"}


def render_plan_lines(items: list) -> list:
    rows = []
    for it in items or []:
        text = str((it or {}).get("text") or "").strip()
        if not text:
            continue
        day = str((it or {}).get("date") or "").strip()
        tail = f" @{day}" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) else ""
        rows.append(f"- [{'x' if (it or {}).get('done') else ' '}] {text}{tail}")
    return rows


def replace_list_section(text: str, heading: str, items: list) -> str:
    """整节替换 `## 本月目标` / `## 本周重点` 下的 checklist 行。

    只动这一节，别的节和手写内容原样保留。
    """
    lines = text.splitlines()
    start = None
    for i, raw in enumerate(lines):
        if raw.strip().startswith("## ") and heading in raw:
            start = i
            break
    block = [f"## {heading}"] + render_plan_lines(items)
    if start is None:
        out = text.rstrip("\n") + "\n\n" + "\n".join(block) + "\n"
        return out
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].strip().startswith("## "):
            end = j
            break
    tail = lines[end:]
    head = lines[:start]
    merged = head + block + ([""] if tail else []) + tail
    out = "\n".join(merged)
    if text.endswith("\n"):
        out += "\n"
    return out


def api_save_plans(payload: dict) -> dict:
    """整节保存月目标 / 关键节点 / 本周重点，供界面就地编辑。"""
    kind = str(payload.get("kind") or "").strip()
    key = str(payload.get("key") or "").strip()
    if kind == "month":
        if not re.fullmatch(r"\d{4}-\d{2}", key):
            raise ValueError("key 必须是 YYYY-MM")
        path = month_path(key)
        head = (f"---\ntype: 月计划\nmonth: {key}\ntags:\n  - 日程\n---\n\n"
                f"# {key[:4]} 年 {int(key[5:7])} 月\n")
        sections = [("本月目标", payload.get("goals")), ("关键节点", payload.get("milestones"))]
    elif kind == "week":
        if not re.fullmatch(r"\d{4}-W\d{2}", key):
            raise ValueError("key 必须是 YYYY-Www")
        path = week_path(key)
        head = (f"---\ntype: 周计划\nweek: {key}\ntags:\n  - 日程\n---\n\n"
                f"# {key[:4]} 第 {int(key[6:])} 周\n")
        sections = [("本周重点", payload.get("goals"))]
    else:
        raise ValueError("kind 只能是 month 或 week")
    with LOCK:
        text = read_text(path) or head
        for heading, items in sections:
            if items is None:
                continue
            text = replace_list_section(text, heading, items)
        write_text(path, text)
        if kind == "month":
            plan = parse_month(key, text)
        else:
            plan = parse_week(key, text)
    return {"ok": True, "kind": kind, "key": key, "plan": plan}


# ---------------------------------------------------------------- HTTP


class Handler(http.server.BaseHTTPRequestHandler):
    # 版本号只在这里出现；对外 HTTP 头必须是 ASCII，所以正式名写 rev1，
    # 对应的中文版本名（第八轮 · 修订版一）在 git tag / Release 上。
    server_version = f"ScheduleCalendar/{APP_VERSION}"

    def log_message(self, fmt, *args):
        pass  # 静音, 避免刷屏

    def _auth_ok(self) -> bool:
        """本机免密；外部优先 30 天 Bearer，旧客户端仍可用 Basic"""
        ip = self.client_address[0] if self.client_address else ""
        if ip in ("127.0.0.1", "::1"):
            return True
        hdr = self.headers.get("Authorization", "")
        if hdr.startswith("Bearer "):
            return auth_token_valid(hdr[7:].strip())
        cfg = load_auth()
        if not cfg.get("password"):
            return False
        if not hdr.startswith("Basic "):
            return False
        try:
            raw = base64.b64decode(hdr[6:]).decode("utf-8")
            user, _, pwd = raw.partition(":")
        except Exception:  # noqa: BLE001
            return False
        return (hmac.compare_digest(user.encode("utf-8"), str(cfg.get("user", "")).encode("utf-8"))
                and hmac.compare_digest(pwd.encode("utf-8"), str(cfg["password"]).encode("utf-8")))

    def _is_local(self) -> bool:
        ip = self.client_address[0] if self.client_address else ""
        return ip in ("127.0.0.1", "::1")

    def _sticker_status(self) -> dict:
        bridge = STICKER_BRIDGE if self._is_local() else None
        if bridge is None:
            return {"available": False, "active": []}
        return {"available": True, "active": bridge.active_ids()}

    def _deny(self):
        self._json({"ok": False, "error": "需要登录"}, 401)

    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8"):
        compressed = False
        text_like = ctype.startswith(("text/", "application/json", "application/javascript"))
        if len(body) > 1024 and text_like and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, 5)
            compressed = True
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _static(self, path: str):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        target = os.path.normpath(os.path.join(WEB, rel))
        if not safe_inside(WEB, target) or not os.path.isfile(target):
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        ext = os.path.splitext(target)[1].lower()
        ctype = {".html": "text/html; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
                 ".json": "application/json; charset=utf-8"}.get(ext, "application/octet-stream")
        with open(target, "rb") as f:
            body = f.read()
        # index.html 里埋了 __APP_VERSION__ / __APP_BUILD__ 占位符：
        # 服务端把「生成这份页面时的版本」注入进去，前端拿它和自己的 ping 结果对比，
        # 就能分辨「界面是旧的」还是「服务是旧的」——前端不许硬编码版本号。
        if ext == ".html":
            body = (body.replace(b"__APP_VERSION__", APP_VERSION.encode())
                        .replace(b"__APP_BUILD__", APP_BUILD.encode()))
        self._send(200, body, ctype)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/schedule-ca.crt":
            if os.path.isfile(CA_CERT):
                with open(CA_CERT, "rb") as f:
                    self._send(200, f.read(), "application/x-x509-ca-cert")
            else:
                self._send(404, b"CA certificate not generated", "text/plain; charset=utf-8")
            return
        if parsed.path.startswith("/api/") and not self._auth_ok():
            self._deny()
            return
        if parsed.path == "/api/ping":
            # realPort 取真实监听端口：桌面壳内嵌服务常常不是 8770（现在听 8769），
            # 回 server.PORT 常量会指错端口，让人以为「手机上打不开是这个地址」。
            try:
                real_port = self.server.server_address[1]
            except Exception:
                real_port = PORT
            self._json({
                "ok": True,
                "version": APP_VERSION,
                "build": APP_BUILD,
                "pid": os.getpid(),
                "bootAt": BOOT_AT,
                "bootAtText": time.strftime("%H:%M:%S", time.localtime(BOOT_AT)),
                "vault": VAULT,
                "port": PORT,
                "realPort": real_port,
                "lan": lan_ip(),
            })
        elif parsed.path == "/api/range":
            qs = urllib.parse.parse_qs(parsed.query)
            q = {k: v[0] for k, v in qs.items()}
            data = api_range(q)
            data["sticker"] = self._sticker_status()
            self._json(data)
        elif parsed.path == "/api/search":
            qs = urllib.parse.parse_qs(parsed.query)
            self._json(api_search((qs.get("q") or [""])[0]))
        elif parsed.path == "/api/notes":
            data = api_notes()
            data["sticker"] = self._sticker_status()
            self._json(data)
        elif parsed.path == "/api/notes/settings":
            data = api_notes()
            data["sticker"] = self._sticker_status()
            self._json(data)
        elif parsed.path == "/api/sticker/status":
            self._json({"ok": True, **self._sticker_status()})
        else:
            self._static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        public_auth = ("/api/auth/login", "/api/auth/refresh")
        if parsed.path not in public_auth and not self._auth_ok():
            self._deny()
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except UnicodeDecodeError:
            try:  # 有些命令行工具/旧脚本会发 GBK
                payload = json.loads(raw.decode("gbk") or "{}")
            except Exception:  # noqa: BLE001
                self._json({"ok": False, "error": "请求体既不是 UTF-8 也不是 GBK"}, 400)
                return
        except json.JSONDecodeError:
            self._json({"ok": False, "error": "JSON 解析失败"}, 400)
            return
        # 谁在写：desktop / phone。冲突时以桌面端为准（2026-10-29 F）
        if isinstance(payload, dict) and "_client" not in payload:
            payload["_client"] = (self.headers.get("X-Client") or "").strip().lower()
        try:
            if parsed.path == "/api/auth/login":
                try:
                    self._json(api_auth_login(payload))
                except ValueError as e:
                    self._json({"ok": False, "error": str(e)}, 401)
            elif parsed.path == "/api/auth/refresh":
                hdr = self.headers.get("Authorization", "")
                token = hdr[7:].strip() if hdr.startswith("Bearer ") else str(payload.get("token") or "")
                try:
                    self._json(api_auth_refresh(token))
                except ValueError as e:
                    self._json({"ok": False, "error": str(e)}, 401)
            elif parsed.path == "/api/day":
                self._json(api_save_day(payload))
            elif parsed.path == "/api/notes":
                self._json(api_save_note(payload))
            elif parsed.path == "/api/notes/folder":
                self._json(api_note_folder(payload))
            elif parsed.path == "/api/notes/move":
                self._json(api_note_move(payload))
            elif parsed.path == "/api/notes/archive":
                self._json(api_note_archive(payload))
            elif parsed.path == "/api/notes/settings":
                self._json(api_notes_settings(payload))
            elif parsed.path == "/api/plans":
                self._json(api_save_plans(payload))
            elif parsed.path == "/api/sticker/toggle":
                bridge = STICKER_BRIDGE if self._is_local() else None
                if bridge is None:
                    self._json({"ok": False, "error": "贴纸仅在桌面应用中可用"}, 403)
                else:
                    self._json(bridge.toggle(str(payload.get("note_id") or "")))
            elif parsed.path == "/api/text":
                self._json(api_save_text(payload))
            elif parsed.path == "/api/goal":
                self._json(api_toggle_goal(payload))
            else:
                self._json({"ok": False, "error": "unknown endpoint"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"ok": False, "error": str(e)}, 500)


class Server(socketserver.ThreadingTCPServer):
    # Windows 上 SO_REUSEADDR 允许两个进程绑同一端口, 会导致并发写同一批文件。
    # 这里关掉, 保证同时只有一个服务实例。
    allow_reuse_address = False
    daemon_threads = True


class SecureServer(Server):
    """可选 HTTPS；证书不存在时完全不启用。"""

    def __init__(self, addr, handler, certfile: str, keyfile: str):
        super().__init__(addr, handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certfile, keyfile)
        self.socket = context.wrap_socket(self.socket, server_side=True)


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    os.makedirs(VAULT, exist_ok=True)
    auth = ensure_auth()
    try:
        httpd = Server(("0.0.0.0", PORT), Handler)
    except OSError as e:
        print(f"端口 {PORT} 已被占用，服务大概已经在运行了。({e})")
        print("浏览器直接开 http://127.0.0.1:%d 就行。" % PORT)
        return
    httpsd = None
    if os.path.isfile(HTTPS_CERT) and os.path.isfile(HTTPS_KEY):
        try:
            httpsd = SecureServer(("0.0.0.0", HTTPS_PORT), Handler, HTTPS_CERT, HTTPS_KEY)
            threading.Thread(target=httpsd.serve_forever, daemon=True).start()
        except Exception as e:  # noqa: BLE001
            httpsd = None
            print(f"HTTPS {HTTPS_PORT} 未启动：{e}")
    print(f"日程服务已启动")
    print(f"  电脑: http://127.0.0.1:{PORT}    (本机不用密码)")
    print(f"  手机: http://{lan_ip()}:{PORT}")
    if httpsd:
        print(f"  手机 HTTPS: https://{lan_ip()}:{HTTPS_PORT}")
        print(f"  手机证书: http://{lan_ip()}:{PORT}/schedule-ca.crt")
    else:
        print("  HTTPS 未启用；运行 tools/setup_https.py 生成证书后重启")
    print(f"        用户 {auth['user']}   密码见 auth.json（不在此处打印）")
    print(f"  数据: {VAULT}")
    print("Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
        if httpsd:
            httpsd.shutdown()
            httpsd.server_close()


if __name__ == "__main__":
    main()
