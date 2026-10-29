# -*- coding: utf-8 -*-
"""便签存储层：一条便签 = Obsidian vault 里的一个 md 文件。

长期规则（见 AGENTS.md）：适合人类直接读写的数据优先落成 vault 里的 md，
不另造私有 json。本模块是便签的唯一读写入口，网页、主界面、贴纸窗口都走它。

目录约定
    根目录可配置（notes-config.json / SCHEDULE_NOTES_ROOT）
    收件箱\\        新建便签默认落点
    _归档\\         删除 = 移到这里，不真删
    任意子文件夹    用户自建，任意层

单文件格式
    ---
    tags: [人的话]
    id: note-xxxxxxxx
    pinned: false
    created: 2026-10-25T14:00
    updated: 2026-10-25T14:05
    ---

    # 标题

    正文
"""
import datetime
import hashlib
import json
import os
import re
import secrets
import shutil

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE, "notes-config.json")
DEFAULT_ROOT = os.environ.get(
    "SCHEDULE_NOTES_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "数据", "便签")

INBOX = "收件箱"
ARCHIVE = "_归档"
TAG_LINE = "tags: [人的话]"
ILLEGAL = '\\/:*?"<>|'
MAX_TITLE = 100
MAX_BODY = 20000
MAX_NAME = 80


# ---------------------------------------------------------------- 根目录

def config_path() -> str:
    return CONFIG_FILE


def read_config() -> dict:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def notes_root() -> str:
    env = os.environ.get("SCHEDULE_NOTES_ROOT")
    if env:
        return env
    cfg = read_config()
    root = str(cfg.get("root") or "").strip()
    return root or DEFAULT_ROOT


def set_notes_root(path: str) -> str:
    root = os.path.abspath(os.path.expanduser(str(path or "").strip()))
    if not root:
        raise ValueError("根目录不能为空")
    os.makedirs(root, exist_ok=True)
    os.makedirs(os.path.join(root, INBOX), exist_ok=True)
    os.makedirs(os.path.join(root, ARCHIVE), exist_ok=True)
    data = read_config()
    data["root"] = root
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_FILE)
    return root


def ensure_layout(root: str | None = None):
    root = root or notes_root()
    os.makedirs(os.path.join(root, INBOX), exist_ok=True)
    os.makedirs(os.path.join(root, ARCHIVE), exist_ok=True)
    return root


# ---------------------------------------------------------------- 路径与命名

def _rel(path: str, root: str) -> str:
    rel = os.path.relpath(path, root).replace(os.sep, "/")
    return "" if rel == "." else rel


def safe_title(title: str) -> str:
    text = str(title or "").strip()
    for ch in ILLEGAL:
        text = text.replace(ch, "")
    text = re.sub(r"[\r\n\t]+", " ", text).strip().strip(".")
    text = text[:MAX_NAME].strip()
    return text or "无标题"


def safe_folder(folder: str) -> str:
    """校验并规范化相对文件夹路径；禁止越界。"""
    raw = str(folder or "").replace("\\", "/").strip()
    parts = []
    for seg in raw.split("/"):
        seg = seg.strip()
        if not seg or seg == ".":
            continue
        if seg == "..":
            raise ValueError("文件夹路径越界")
        clean = safe_title(seg)
        if clean != seg:
            raise ValueError("文件夹名含非法字符")
        parts.append(seg)
    return "/".join(parts)


def note_path_for(folder: str, title: str, exclude: str | None = None) -> str:
    """在 folder 下给 title 找一个不冲突的文件名。"""
    root = notes_root()
    folder_abs = os.path.join(root, *folder.split("/")) if folder else root
    os.makedirs(folder_abs, exist_ok=True)
    base = safe_title(title)
    candidate = os.path.join(folder_abs, base + ".md")
    n = 2
    while os.path.exists(candidate) and os.path.normcase(candidate) != os.path.normcase(exclude or ""):
        candidate = os.path.join(folder_abs, f"{base} ({n}).md")
        n += 1
    return candidate


# ---------------------------------------------------------------- 解析 / 渲染

def _split_front(text: str):
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            meta, cur = {}, None
            for raw in lines[1:i]:
                if not raw.strip():
                    continue
                if raw[:1] in (" ", "\t") and cur:
                    item = raw.strip().lstrip("-").strip()
                    if isinstance(meta.get(cur), list) and item:
                        meta[cur].append(item)
                    continue
                if ":" not in raw:
                    continue
                key, _, val = raw.partition(":")
                key, val = key.strip(), val.strip()
                if val.startswith("[") and val.endswith("]"):
                    meta[key] = [x.strip().strip("'\"") for x in val[1:-1].split(",") if x.strip()]
                    cur = key
                elif val == "":
                    meta[key] = []
                    cur = key
                else:
                    meta[key] = val.strip().strip("'\"")
                    cur = key
            return meta, "\n".join(lines[i + 1:])
    return {}, text


def _norm_time(value, fallback: str = "") -> str:
    """统一成 2026-10-25T14:00（本地时间，分钟精度）。"""
    raw = str(value or "").strip()
    if not raw:
        return fallback
    try:
        if raw.endswith("Z"):
            dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
            dt = dt.astimezone().replace(tzinfo=None)
        else:
            dt = datetime.datetime.fromisoformat(raw)
            if dt.tzinfo is not None:
                dt = dt.astimezone().replace(tzinfo=None)
        return dt.strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        return fallback


def _now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")


def parse_note(path: str, root: str) -> dict:
    rel = _rel(path, root)
    folder = os.path.dirname(rel).replace("\\", "/")
    filename = os.path.basename(path)
    stem = os.path.splitext(filename)[0]
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read()
    except OSError:
        raw = ""
    meta, body = _split_front(raw)
    title, text = "", body
    lines = body.splitlines()
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines) and lines[idx].lstrip().startswith("# "):
        title = lines[idx].lstrip()[2:].strip()
        text = "\n".join(lines[idx + 1:])
    text = text.strip("\n")
    if not title:
        title = stem
    nid = str(meta.get("id") or "").strip()
    if not re.fullmatch(r"note-[A-Za-z0-9-]{4,64}", nid or ""):
        nid = "note-" + hashlib.sha1(rel.encode("utf-8")).hexdigest()[:12]
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0.0
    archived = folder == ARCHIVE or folder.startswith(ARCHIVE + "/")
    return {
        "id": nid,
        "title": title,
        "text": text,
        "pinned": str(meta.get("pinned", "")).lower() in ("true", "1", "yes"),
        "createdAt": _norm_time(meta.get("created"), _fmt_mtime(mtime)),
        "updatedAt": _norm_time(meta.get("updated"), _fmt_mtime(mtime)),
        "folder": folder,
        "file": rel,
        "filename": filename,
        "mtime": mtime,
        "deleted": False,
        "archived": archived,
        "missingTags": "人的话" not in (meta.get("tags") or []),
    }


def _fmt_mtime(mtime: float) -> str:
    try:
        return datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%dT%H:%M")
    except (OSError, OverflowError, ValueError):
        return _now()


def render_note(note: dict) -> str:
    title = str(note.get("title") or "").strip() or "无标题"
    text = str(note.get("text") or "").replace("\r\n", "\n").strip("\n")
    front = [
        "---",
        TAG_LINE,
        f"id: {note['id']}",
        f"pinned: {'true' if note.get('pinned') else 'false'}",
        f"created: {note.get('createdAt') or _now()}",
        f"updated: {note.get('updatedAt') or _now()}",
        "---",
        "",
        f"# {title}",
        "",
    ]
    body = front + ([text, ""] if text else [])
    return "\n".join(body).rstrip("\n") + "\n"


BACKUP_ROOT = os.environ.get("SCHEDULE_BACKUP") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "备份")


def backup_before_write(path: str) -> None:
    """写盘前把旧内容复制到 日程备份 的 _最近一次/便签 目录；失败不影响保存。"""
    try:
        if not os.path.isfile(path):
            return
        root = notes_root()
        if not os.path.abspath(path).lower().startswith(os.path.abspath(root).lower()):
            return
        rel = os.path.relpath(path, root)
        dest = os.path.join(BACKUP_ROOT, "_最近一次", "便签", rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(path, "rb") as src, open(dest + ".tmp", "wb") as dst:
            dst.write(src.read())
        os.replace(dest + ".tmp", dest)
    except Exception as e:  # noqa: BLE001
        print(f"[backup] 跳过（不影响保存）：{e}")


def write_note_file(path: str, note: dict):
    """先写临时文件再原子替换，避免 Obsidian 读到半个文件。"""
    backup_before_write(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    content = render_note(note)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    os.replace(tmp, path)


# ---------------------------------------------------------------- 读取

def _walk(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith(".") or not name.lower().endswith(".md"):
                continue
            yield os.path.join(dirpath, name)


def scan() -> list:
    root = ensure_layout()
    out = []
    for path in _walk(root):
        try:
            out.append(parse_note(path, root))
        except OSError:
            continue
    return out


def find(note_id: str) -> dict | None:
    if not note_id:
        return None
    return next((n for n in scan() if n["id"] == note_id), None)


def tree() -> list:
    """返回文件夹树（含条数），按路径排序。"""
    root = ensure_layout()
    counts = {}
    for note in scan():
        folder = note["folder"]
        if note["archived"]:
            continue
        counts[folder] = counts.get(folder, 0) + 1
    nodes = []
    for dirpath, dirnames, _files in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        rel = _rel(dirpath, root)
        if rel:
            if rel == ARCHIVE or rel.startswith(ARCHIVE + "/"):
                nodes.append({"path": rel, "name": os.path.basename(dirpath),
                              "depth": rel.count("/"), "count": 0, "archive": True})
            else:
                nodes.append({"path": rel, "name": os.path.basename(dirpath),
                              "depth": rel.count("/"), "count": counts.get(rel, 0),
                              "archive": False})
    return nodes


# ---------------------------------------------------------------- 写入

def _validate(payload: dict):
    title = str(payload.get("title") or "").strip()
    text = str(payload.get("text") or "")
    if len(title) > MAX_TITLE:
        raise ValueError("便签标题不能超过 100 字")
    if len(text) > MAX_BODY:
        raise ValueError("便签正文不能超过 20000 字")
    return title, text


def save(payload: dict) -> dict:
    """新建 / 更新（含改名、移动、归档、置顶）。

    没传的字段一律保持原值，避免「只改置顶」把正文清空。
    """
    nid = str(payload.get("id") or "").strip()
    if nid and not re.fullmatch(r"note-[A-Za-z0-9-]{4,64}", nid):
        raise ValueError("便签 id 无效")
    existing = find(nid) if nid else None
    has_title, has_text = "title" in payload, "text" in payload
    title, text = _validate(payload)

    archived = bool(payload.get("archived"))
    if not nid:
        nid = "note-" + secrets.token_hex(8)
        existing = None

    base_mtime = payload.get("baseMtime")
    if existing and base_mtime not in (None, ""):
        try:
            if float(existing["mtime"]) > float(base_mtime) + 1.2:
                return dict(existing, merged="disk-newer")
        except (TypeError, ValueError):
            pass

    if existing:
        note = dict(existing)
        if has_title and title:
            note["title"] = title
        if has_text:
            note["text"] = text
        if "pinned" in payload:
            note["pinned"] = bool(payload.get("pinned"))
        if "updatedAt" in payload:
            note["updatedAt"] = _norm_time(payload.get("updatedAt"), _now())
    else:
        now = _norm_time(payload.get("updatedAt"), _now())
        note = {
            "id": nid,
            "title": title or "无标题",
            "text": text,
            "pinned": bool(payload.get("pinned")),
            "createdAt": _norm_time(payload.get("createdAt"), now),
            "updatedAt": now,
        }

    if not str(note.get("text") or "").strip() and not str(note.get("title") or "").strip():
        raise ValueError("便签需要标题或正文")

    folder = payload.get("folder")
    if folder is None:
        folder = existing["folder"] if existing else INBOX
    folder = safe_folder(folder)
    if archived:
        folder = ARCHIVE

    old_path = None
    if existing:
        old_path = os.path.join(notes_root(), *existing["file"].split("/"))

    target = note_path_for(folder, note.get("title") or "无标题", exclude=old_path)
    write_note_file(target, note)
    if old_path and os.path.normcase(old_path) != os.path.normcase(target) and os.path.isfile(old_path):
        try:
            os.remove(old_path)
        except OSError:
            pass

    saved = parse_note(target, notes_root())
    saved["merged"] = None
    return saved


def archive(note_id: str) -> dict:
    return save({"id": note_id, "archived": True, "pinned": False})


def move(note_id: str, folder: str) -> dict:
    if not find(note_id):
        raise ValueError("便签不存在")
    return save({"id": note_id, "folder": folder})


def folder_create(folder: str) -> dict:
    rel = safe_folder(folder)
    if not rel:
        raise ValueError("文件夹名不能为空")
    path = os.path.join(notes_root(), *rel.split("/"))
    if os.path.isdir(path):
        raise ValueError("文件夹已存在")
    os.makedirs(path, exist_ok=True)
    return {"ok": True, "path": rel}


def folder_rename(old: str, new: str) -> dict:
    src_rel, dst_rel = safe_folder(old), safe_folder(new)
    if not src_rel or not dst_rel:
        raise ValueError("文件夹名不能为空")
    root = notes_root()
    src = os.path.join(root, *src_rel.split("/"))
    dst = os.path.join(root, *dst_rel.split("/"))
    if not os.path.isdir(src):
        raise ValueError("文件夹不存在")
    if os.path.exists(dst):
        raise ValueError("目标文件夹已存在")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.rename(src, dst)
    return {"ok": True, "path": dst_rel}


def folder_delete(folder: str) -> dict:
    rel = safe_folder(folder)
    if not rel:
        raise ValueError("不能删除根目录")
    if rel == ARCHIVE:
        raise ValueError("归档文件夹不能删除")
    root = notes_root()
    path = os.path.join(root, *rel.split("/"))
    if not os.path.isdir(path):
        raise ValueError("文件夹不存在")
    if any(os.scandir(path)):
        raise ValueError("只能删除空文件夹")
    shutil.rmtree(path)
    return {"ok": True}


# ---------------------------------------------------------------- 列表

def list_notes() -> dict:
    items = scan()
    items.sort(key=lambda n: str(n["updatedAt"] or ""), reverse=True)
    items.sort(key=lambda n: (bool(n["archived"]), not n["pinned"]))
    return {
        "ok": True,
        "root": notes_root(),
        "notes": items,
        "tree": tree(),
        "inbox": INBOX,
        "archive": ARCHIVE,
        "legacyFile": legacy_file(),
    }


def legacy_file() -> dict:
    """旧的 便签.json 只用于显示「已迁移」提示，不再作为主存储。"""
    import glob as _glob
    base = os.path.join(os.environ.get("SCHEDULE_VAULT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "数据", "日程"), "便签.json")
    has_bak = bool(_glob.glob(base + ".bak-*"))
    return {"path": base, "exists": os.path.isfile(base), "backedUp": has_bak}


def mtime() -> float:
    """整棵便签目录的最新 mtime，用于外部改动检测。"""
    root = ensure_layout()
    latest = 0.0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if not name.lower().endswith(".md"):
                continue
            try:
                latest = max(latest, os.path.getmtime(os.path.join(dirpath, name)))
            except OSError:
                pass
    return latest
