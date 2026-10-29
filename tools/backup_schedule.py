"""日程每日快照备份（纯标准库，双击或命令行都能跑）。

    python tools\\backup_schedule.py            # 正常备份
    python tools\\backup_schedule.py --dry-run  # 只打印要写什么，不动磁盘
    python tools\\backup_schedule.py --keep 7   # 临时改保留天数（测试用）

规则（2026-10-29 第十一轮 E-2）：
- 输出 `D:\\ai产物\\日程备份\\daily\\日程-YYYY-MM-DD.zip`；同一天重复跑**覆盖同名**，不产生第二份。
- 保留最近 30 天（--keep 可改）；每月 1 号那份另存 `monthly\\日程-YYYY-MM.zip`，保留 12 个月。
- 备份范围：日程库（跳过 *.bak）+ 便签目录。**备份目录本身不在范围内**，不会自我嵌套。
"""
import argparse
import datetime as dt
import os
import sys
import zipfile

SCHEDULE_ROOT = os.environ.get("SCHEDULE_VAULT", r"D:\Obsidian笔记库\日程")
NOTES_ROOT = os.environ.get(
    "SCHEDULE_NOTES_ROOT", r"D:\Obsidian笔记库\B提炼信息\人的笔记\便签")
BACKUP_ROOT = os.environ.get("SCHEDULE_BACKUP", r"D:\ai产物\日程备份")

SKIP_EXT = {".bak", ".tmp", ".zip"}
SKIP_DIRS = {"_最近一次", "daily", "monthly"}


def collect() -> list:
    """返回 [(绝对路径, zip 内相对名)]。"""
    items = []
    for root, tag in ((SCHEDULE_ROOT, "日程"), (NOTES_ROOT, "便签")):
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for name in filenames:
                low = name.lower()
                if os.path.splitext(name)[1].lower() in SKIP_EXT or ".bak" in low:
                    continue   # 任务书要求「不含 .bak」——便签.json.bak-20261025 这种也算
                full = os.path.join(dirpath, name)
                rel = os.path.join(tag, os.path.relpath(full, root))
                items.append((full, rel.replace("\\", "/")))
    return sorted(items, key=lambda x: x[1])


def prune(folder: str, keep: int, dry: bool) -> list:
    """按文件名日期保留最近 keep 份，返回被删的文件名。"""
    if not os.path.isdir(folder):
        return []
    names = sorted(n for n in os.listdir(folder) if n.lower().endswith(".zip"))
    doomed = names[:-keep] if keep > 0 else []
    if not dry:
        for n in doomed:
            try:
                os.remove(os.path.join(folder, n))
            except OSError:
                pass
    return doomed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写盘")
    ap.add_argument("--keep", type=int, default=30, help="保留多少天（默认 30）")
    args = ap.parse_args()

    today = dt.date.today()
    items = collect()
    total = sum(os.path.getsize(p) for p, _ in items)
    daily_dir = os.path.join(BACKUP_ROOT, "daily")
    monthly_dir = os.path.join(BACKUP_ROOT, "monthly")
    daily_zip = os.path.join(daily_dir, f"日程-{today:%Y-%m-%d}.zip")
    is_first = today.day == 1
    monthly_zip = os.path.join(monthly_dir, f"日程-{today:%Y-%m}.zip")

    print(f"备份范围：{SCHEDULE_ROOT}  +  {NOTES_ROOT}")
    print(f"文件数：{len(items)}　总字节：{total:,}（{total / 1024:.1f} KB）")
    print(f"写入：{daily_zip}")
    if is_first:
        print(f"另存：{monthly_zip}（每月 1 号）")

    if args.dry_run:
        for full, rel in items:
            print(f"  {rel}  {os.path.getsize(full):,}B")
        doomed_daily = prune(daily_dir, args.keep, True)
        doomed_monthly = prune(monthly_dir, 12, True)
        print(f"[dry-run] 会清理 daily {len(doomed_daily)} 个、monthly {len(doomed_monthly)} 个")
        return 0

    for folder in (daily_dir, monthly_dir):
        os.makedirs(folder, exist_ok=True)

    # 先写临时文件再替换：中途失败不会留下半个 zip
    tmp = daily_zip + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for full, rel in items:
            zf.write(full, rel)
    os.replace(tmp, daily_zip)
    size = os.path.getsize(daily_zip)
    print(f"完成：{os.path.basename(daily_zip)}　{size:,}B（{size / 1024:.1f} KB）")

    if is_first:
        tmp_m = monthly_zip + ".tmp"
        with zipfile.ZipFile(tmp_m, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for full, rel in items:
                zf.write(full, rel)
        os.replace(tmp_m, monthly_zip)
        print(f"完成：{os.path.basename(monthly_zip)}")

    old_daily = prune(daily_dir, args.keep, False)
    old_monthly = prune(monthly_dir, 12, False)
    if old_daily or old_monthly:
        print(f"清理：daily {len(old_daily)} 个、monthly {len(old_monthly)} 个")

    write_readme()
    used = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fs in os.walk(BACKUP_ROOT) for f in fs
    )
    print(f"备份目录当前占用：{used / 1024:.0f} KB")
    return 0


def write_readme() -> None:
    path = os.path.join(BACKUP_ROOT, "说明.txt")
    text = """日程备份怎么用（三步）

一、只想找回某一天的一处改动
    打开 日程备份\\_最近一次\\，这里永远是「上一次保存之前」的样子。
    路径跟原文件一样（日程\\2026\\2026-10-29.md、便签\\xxx.md），复制回去覆盖即可。

二、想恢复整整一天
    打开 日程备份\\daily\\，找「日程-YYYY-MM-DD.zip」，解压后是两个文件夹：
    日程\\ 和 便签\\。把要的文件复制回原位置。

三、想整包回到某个版本
    解压对应日期的 zip，把里面 日程\\ 和 便签\\ 两个文件夹整体覆盖回去。

注意
- 每天只留一份，同一天跑多次会覆盖，不会越堆越多。
- 保留最近 30 天；每月 1 号多存一份到 monthly\\，保留 12 个月。
- 备份不包含 certs、auth.json、程序代码，只备份你的日程和便签。
"""
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    except OSError:
        pass


if __name__ == "__main__":
    sys.exit(main())
