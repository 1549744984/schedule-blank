#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成本地 HTTPS 证书（标准库 + 系统 OpenSSL）。

- 根证书只生成一次；已存在就复用，避免手机重复信任。
- 服务器证书每次按当前局域网 IP 重签。
- 私钥只留在 certs/，并已被 .gitignore 排除。
"""
import os
import shutil
import socket
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT_DIR = os.path.join(BASE, "certs")
CA_CRT = os.path.join(CERT_DIR, "ca.crt")
CA_KEY = os.path.join(CERT_DIR, "ca.key")
SERVER_CRT = os.path.join(CERT_DIR, "server.crt")
SERVER_KEY = os.path.join(CERT_DIR, "server.key")
SERVER_CSR = os.path.join(CERT_DIR, "server.csr")
EXT_FILE = os.path.join(CERT_DIR, "server-ext.cnf")


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"



def all_local_ips() -> list:
    """所有网卡的 IPv4（含 127.0.0.1），去重后按稳定顺序返回。
    只用标准库；拿不到就退回当前 IP，不让签证书这件事失败。"""
    found = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found:
                found.append(ip)
    except OSError:
        pass
    try:
        import subprocess
        out = subprocess.run(["ipconfig"], capture_output=True, text=True, timeout=8).stdout
        import re
        for m in re.finditer(r"IPv4[^:：]*[:：]\s*([0-9.]+)", out):
            ip = m.group(1)
            if ip not in found:
                found.append(ip)
    except Exception:  # noqa: BLE001
        pass
    if "127.0.0.1" not in found:
        found.insert(0, "127.0.0.1")
    # 127 开头放最前，其余稳定排序
    return sorted(set(found), key=lambda x: (not x.startswith("127."), x))

def find_openssl() -> str:
    candidates = [
        shutil.which("openssl"),
        r"C:\Program Files\Git\usr\bin\openssl.exe",
        r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
        r"C:\Program Files (x86)\OpenSSL-Win32\bin\openssl.exe",
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    raise SystemExit("找不到 OpenSSL。先安装 Git for Windows，或把 openssl.exe 放进 PATH。")


def run(cmd: list):
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        print("命令失败：", " ".join(cmd))
        print(result.stdout)
        print(result.stderr)
        raise SystemExit(result.returncode)


def main():
    os.makedirs(CERT_DIR, exist_ok=True)
    openssl = find_openssl()
    ip = lan_ip()

    if not (os.path.isfile(CA_CRT) and os.path.isfile(CA_KEY)):
        print("生成本地根证书（手机以后只需信任一次）…")
        run([
            openssl, "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
            "-keyout", CA_KEY, "-out", CA_CRT,
            "-subj", "/CN=Schedule Local CA",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        ])
    else:
        print("复用已有根证书：", CA_CRT)

    # 2026-10-29 G-2：SAN 不再只写一个 IP。
    # 原来只放当前网卡 IP，换一次 WiFi / 换个网络，手机就报证书不匹配。
    # 现在把「所有网卡 IPv4 + localhost + 127.0.0.1 + 主机名」都写进去，换网也不用重签。
    ips = all_local_ips()
    names = []
    for i, one in enumerate(ips, start=1):
        names.append(f"IP.{i}={one}")
    dns = ["localhost", socket.gethostname()]
    dns_lines = [f"DNS.{i}={n}" for i, n in enumerate(dns, start=1)]
    body = (
        "[server_ext]\n"
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        "subjectAltName=@alt_names\n\n"
        "[alt_names]\n"
        + "\n".join(dns_lines) + "\n"
        + "\n".join(names) + "\n"
    )
    with open(EXT_FILE, "w", encoding="ascii", newline="\n") as f:
        f.write(body)
    print("证书将包含：", ", ".join(dns + ips))

    print(f"按当前局域网 IP 重签服务器证书：{ip}")
    run([
        openssl, "req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-keyout", SERVER_KEY, "-out", SERVER_CSR, "-subj", f"/CN={ip}",
    ])
    run([
        openssl, "x509", "-req", "-in", SERVER_CSR, "-CA", CA_CRT, "-CAkey", CA_KEY,
        "-CAcreateserial", "-out", SERVER_CRT, "-days", "825", "-sha256",
        "-extfile", EXT_FILE, "-extensions", "server_ext",
    ])
    for tmp in (SERVER_CSR, EXT_FILE):
        try:
            os.remove(tmp)
        except OSError:
            pass

    print("\n完成。")
    print("根证书（手机要安装这一份）：", CA_CRT)
    print("服务器证书：", SERVER_CRT)
    print("服务器私钥（不要外传）：", SERVER_KEY)
    print(f"手机下载根证书： http://{ip}:8770/schedule-ca.crt")
    print(f"安装信任后打开： https://{ip}:8771")
    print("生成证书后必须重启 server.py 才会启用 HTTPS。")
    print("如果电脑换了 WiFi、局域网 IP 变化，重新运行本脚本即可；根证书不用重装。")


if __name__ == "__main__":
    main()
