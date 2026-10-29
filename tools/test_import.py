# -*- coding: utf-8 -*-
"""导入回归测试：全程临时目录，不碰真实日程。

用法:
  python tools/test_import.py            # 跑 6 项，打印逐项结果
  python tools/test_import.py --keep     # 跑完保留临时目录（用于截图核对）

覆盖（对应《试用修复轮》D1）：
  1 只有标题、没有时间       → 自动落成「全天」
  2 跨天全天事件             → 按天拆成多条（引擎不支持跨天，协议要求 AI 先拆）
  3 带地点                   → @地点 归一化，三视图可见
  4 priority=high            → `! ` 前缀 + 重点色
  5 待办多条（含已完成 / 重点）
  6 同一天已有事件时追加      → mode=append，原有事件必须保留
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8799


def post(path, payload):
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": e.read().decode("utf-8", "replace"), "status": e.code}


def get(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_up(timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            get("/api/ping")
            return True
        except Exception:
            time.sleep(0.3)
    return False


def md_of(vault, date):
    p = os.path.join(vault, date[:4], f"{date}.md")
    return open(p, encoding="utf-8").read() if os.path.exists(p) else ""


def section(md, name):
    a = md.find(f"<!-- AUTO:{name}:start -->")
    b = md.find(f"<!-- AUTO:{name}:end -->")
    if a < 0 or b < 0:
        return []
    return [l for l in md[a:b].splitlines() if l.strip().startswith("- ")]


CASES = []


def case(no, name):
    def deco(fn):
        CASES.append((no, name, fn))
        return fn
    return deco


@case(1, "只有标题、没有时间 → 全天")
def _c1(vault):
    d = "2026-11-01"
    r = post("/api/day", {"date": d, "mode": "replace", "events": [{"title": "交材料"}]})
    lines = section(md_of(vault, d), "events")
    ok = r.get("ok") and lines == ["- 全天 交材料"]
    return ok, f"落盘 {lines}"


@case(2, "跨天全天事件 → 服务端自动展开成每天一条")
def _c2(vault):
    r = post("/api/day", {"date": "2026-11-02", "events": [
        {"title": "认知实习", "location": "黄龙", "end_date": "2026-11-04"}]})
    days = ("2026-11-02", "2026-11-03", "2026-11-04")
    got = {d: section(md_of(vault, d), "events") for d in days}
    ok = bool(r.get("ok")) and all(got[d] == ["- 全天 认知实习 @黄龙"] for d in days)
    return ok, "；".join(f"{d}:{got[d]}" for d in days)


@case(3, "带地点 → @地点")
def _c3(vault):
    d = "2026-11-04"
    r = post("/api/day", {"date": d, "mode": "append", "events": [
        {"start": "14:00", "end": "15:30", "title": "组会", "location": "图书馆 三楼"}]})
    lines = section(md_of(vault, d), "events")
    # 2026-10-29 契约变更：地点里的空格**原样保留**（他会输入「东盟 G-4012」这种带空格的门牌），
    # 原来 replace(" ","") 会把「图书馆 三楼」压成「图书馆三楼」。旧数据（无空格）仍能读。
    ok = bool(r.get("ok")) and "- 14:00-15:30 组会 @图书馆 三楼" in lines
    return ok, f"落盘 {lines}（地点空格保留）"


@case(4, "重点 priority=high → ! 前缀")
def _c4(vault):
    d = "2026-11-05"
    r = post("/api/day", {"date": d, "events": [
        {"start": "09:00", "end": "10:00", "title": "交作业", "priority": "high", "location": "教务处"}]})
    lines = section(md_of(vault, d), "events")
    ok = r.get("ok") and lines == ["- 09:00-10:00 ! 交作业 @教务处"]
    return ok, f"落盘 {lines}"


@case(5, "待办多条（含已完成 / 重点）")
def _c5(vault):
    d = "2026-11-06"
    r = post("/api/day", {"date": d, "todos": [
        {"done": False, "text": "买笔记本"},
        {"done": True, "text": "回消息"},
        {"done": False, "text": "交材料", "priority": "high"}]})
    lines = section(md_of(vault, d), "todos")
    ok = r.get("ok") and lines == ["- [ ] 买笔记本", "- [x] 回消息", "- [ ] ! 交材料"]
    return ok, f"落盘 {lines}"


@case(6, "同一天已有事件时追加 → 不覆盖")
def _c6(vault):
    d = "2026-11-07"
    post("/api/day", {"date": d, "events": [
        {"start": "09:00", "end": "10:00", "title": "原有日程", "location": "家"}]})
    r = post("/api/day", {"date": d, "mode": "append", "events": [
        {"start": "15:00", "end": "16:00", "title": "新导入的", "tags": ["课程"]}]})
    lines = section(md_of(vault, d), "events")
    ok = r.get("ok") and len(lines) == 2 and any("原有日程" in l for l in lines)
    return ok, f"落盘 {lines}"


@case(7, "追加时时间冲突要报出来，不能静默")
def _c7(vault):
    d = "2026-11-08"
    post("/api/day", {"date": d, "events": [
        {"start": "14:00", "end": "16:00", "title": "家教"}]})
    r = post("/api/day", {"date": d, "mode": "append", "events": [
        {"start": "15:00", "end": "15:30", "title": "开会"}]})
    got = r.get("conflicts") or []
    return bool(got), f"conflicts={json.dumps(got, ensure_ascii=False)}"


@case(8, "跨天展开时，后面几天已有的日程不能被清掉")
def _c8(vault):
    d0, d1 = "2026-11-10", "2026-11-11"
    post("/api/day", {"date": d1, "events": [
        {"start": "09:00", "end": "10:00", "title": "原有课"}]})
    post("/api/day", {"date": d0, "events": [
        {"title": "研学", "end_date": "2026-11-12"}]})
    kept = section(md_of(vault, d1), "events")
    ok = len(kept) == 2 and any("原有课" in l for l in kept)
    return ok, f"{d1} 落盘 {kept}"


@case(9, "不传 mode 时默认是追加（不会冲掉当天）")
def _c9(vault):
    d = "2026-11-13"
    post("/api/day", {"date": d, "mode": "replace", "events": [
        {"start": "09:00", "end": "10:00", "title": "已有日程"}]})
    r = post("/api/day", {"date": d, "events": [
        {"start": "15:00", "end": "16:00", "title": "漏传 mode 的"}]})
    lines = section(md_of(vault, d), "events")
    ok = r.get("mode") == "append" and len(lines) == 2 and any("已有日程" in l for l in lines)
    return ok, f"mode={r.get('mode')} 落盘 {lines}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    vault = tempfile.mkdtemp(prefix="vault-test-")
    env = dict(os.environ, SCHEDULE_VAULT=vault, SCHEDULE_PORT=str(PORT), SCHEDULE_HTTPS_PORT="8798",
               SCHEDULE_BACKUP=os.path.join(vault, "_备份"),
               SCHEDULE_NOTES_ROOT=os.path.join(vault, "_便签"))   # 自检不许写进真实目录
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")],
                            env=env, cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_up():
            raise SystemExit("测试服务没起来（端口 %d）" % PORT)
        print(f"临时数据目录：{vault}\n")
        fails = 0
        for no, name, fn in CASES:
            try:
                ok, detail = fn(vault)
            except Exception as e:
                ok, detail = False, f"异常 {e}"
            print(f"[{'通过' if ok else '失败'}] {no} {name}\n        {detail}")
            fails += 0 if ok else 1
        print(f"\n{len(CASES) - fails}/{len(CASES)} 通过")

        # 三视图能不能读出来，用接口过一遍
        rng = get("/api/range?from=2026-11-01&to=2026-11-08")
        days = rng.get("days") or {}
        print("接口回读：")
        for d in sorted(days):
            ev = days[d].get("events") or []
            td = days[d].get("todos") or []
            if ev or td:
                print("  %s 事件%d 待办%d  %s" % (
                    d, len(ev), len(td),
                    "；".join(("%s-%s %s%s" % (e.get("start"), e.get("end"), e.get("title"),
                                              "/重点" if e.get("priority") == "high" else ""))
                             if not e.get("allday") else ("全天 " + e.get("title")) for e in ev)))
        if args.keep:
            print(f"\n保留目录：{vault}")
            print("截图：python tools/shot.py --url http://127.0.0.1:%d/?view=day\\&d=2026-11-05 --out x.png" % PORT)
            input("按回车结束并关闭测试服务…")
        return 1 if fails else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        if not args.keep:
            shutil.rmtree(vault, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
