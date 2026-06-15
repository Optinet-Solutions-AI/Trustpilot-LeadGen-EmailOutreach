#!/usr/bin/env python3
"""
tools/deploy/ftp_deploy.py — Deploy the static marketing sites in brand/sites/
to Bluehost over explicit FTPS (falls back to plain FTP).

Credentials are read from the free-text block pasted into .env:
    Domain: rateuphub.com
    Hostname: htw.kcl.mybluehost.me
    Username: jhon@rateuphub.com
    Password: ********
    Home Directory: /home1/htwkclmy/public_html/website_xxxxxxxx

Each domain maps to its local site folder via the <link rel="canonical">
baked into that folder's index.html (see DOMAIN_TO_FOLDER).

Usage:
  # Non-destructive connectivity test — login + show remote web root:
  python tools/deploy/ftp_deploy.py --list --all
  python tools/deploy/ftp_deploy.py --list --site rateup-hub

  # Upload (recursive, mirrors assets/ structure):
  python tools/deploy/ftp_deploy.py --upload --site rateup-hub
  python tools/deploy/ftp_deploy.py --upload --all
"""
import argparse
import ftplib
import ssl
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ENV = REPO / ".env"
SITES = REPO / "brand" / "sites"

# domain -> local folder, derived from each site's <link rel="canonical">
DOMAIN_TO_FOLDER = {
    "rateuphub.com": "rateup-hub",
    "rateupglobal.com": "rateup-global",
    "rateupdigital.com": "rateup-digital",
    "optiratesolutions.org": "site-c",
    "optiratesolutions.net": "site-b",
    "optiratessolutions.com": "site-a",
}
FOLDER_TO_DOMAIN = {v: k for k, v in DOMAIN_TO_FOLDER.items()}


def parse_creds(env_path: Path) -> dict:
    """Parse the free-text FTP block in .env into {domain: {host,user,password,home}}."""
    creds, cur = {}, None
    for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        low = line.lower()
        if low.startswith("domain:"):
            dom = line.split(":", 1)[1].strip().lower()
            cur = {"domain": dom}
            creds[dom] = cur
        elif cur is not None:
            for key, field in (
                ("hostname:", "host"),
                ("username:", "user"),
                ("password:", "password"),
                ("home directory:", "home"),
            ):
                if low.startswith(key):
                    cur[field] = line.split(":", 1)[1].strip()
    return creds


def connect(host: str, user: str, password: str):
    """Explicit FTPS, tolerant of a shared/mismatched cert; fall back to plain FTP."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ftp = ftplib.FTP_TLS(context=ctx, timeout=30)
        ftp.connect(host, 21)
        ftp.login(user, password)
        ftp.prot_p()
        return ftp, "FTPS"
    except Exception:
        try:
            ftp.close()
        except Exception:
            pass
        ftp = ftplib.FTP(timeout=30)
        ftp.connect(host, 21)
        ftp.login(user, password)
        return ftp, "FTP(plain)"


def _mkd_p(ftp, root: str, relpath: str):
    """Ensure root/relpath exists, creating each level. relpath uses '/'."""
    path = root
    for part in relpath.split("/"):
        if not part:
            continue
        path = f"{path}/{part}"
        try:
            ftp.mkd(path)
        except ftplib.error_perm as e:
            if not str(e).startswith("550"):  # 550 = already exists / no perm
                raise


def upload_tree(ftp, local_dir: Path, root: str):
    """Recursively upload local_dir contents into remote `root`."""
    files = sorted(p for p in local_dir.rglob("*") if p.is_file())
    made = set()
    n = 0
    for f in files:
        rel = f.relative_to(local_dir).as_posix()
        subdir = rel.rsplit("/", 1)[0] if "/" in rel else ""
        if subdir and subdir not in made:
            _mkd_p(ftp, root, subdir)
            made.add(subdir)
        remote = f"{root}/{rel}"
        with f.open("rb") as fh:
            ftp.storbinary(f"STOR {remote}", fh)
        n += 1
        print(f"    + {rel} ({f.stat().st_size:,} B)")
    return n


def do_site(domain: str, c: dict, mode: str):
    folder = DOMAIN_TO_FOLDER.get(domain)
    local = SITES / folder if folder else None
    print(f"\n=== {domain}  ->  {folder or '(no mapping)'} ===")
    if not local or not local.is_dir():
        print(f"  !! local folder missing: {local}")
        return False
    missing = [k for k in ("host", "user", "password") if not c.get(k)]
    if missing:
        print(f"  !! missing creds: {missing}")
        return False
    try:
        ftp, proto = connect(c["host"], c["user"], c["password"])
    except Exception as e:
        print(f"  !! connect/login failed: {e}")
        return False
    try:
        root = ftp.pwd().rstrip("/") or ""
        print(f"  connected via {proto} as {c['user']}")
        print(f"  login dir (web root): {root or '/'}")
        try:
            entries = ftp.nlst()
        except Exception:
            entries = []
        print(f"  remote contents ({len(entries)}): {', '.join(entries[:25]) or '(empty)'}")
        if mode == "list":
            return True
        # upload
        count = sorted(p for p in local.rglob('*') if p.is_file())
        print(f"  uploading {len(count)} files from {local.name}/ ...")
        n = upload_tree(ftp, local, root)
        after = []
        try:
            after = ftp.nlst()
        except Exception:
            pass
        print(f"  done: {n} files uploaded. remote now has {len(after)} top-level entries.")
        return True
    finally:
        try:
            ftp.quit()
        except Exception:
            try:
                ftp.close()
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--list", action="store_true", help="connectivity test only (no writes)")
    g.add_argument("--upload", action="store_true", help="upload site files")
    ap.add_argument("--site", help="local folder name, e.g. rateup-hub")
    ap.add_argument("--all", action="store_true", help="all mapped sites")
    args = ap.parse_args()

    creds = parse_creds(ENV)
    if not creds:
        print("No FTP credential block found in .env", file=sys.stderr)
        sys.exit(2)

    mode = "list" if args.list else "upload"
    if args.site:
        domain = FOLDER_TO_DOMAIN.get(args.site)
        if not domain:
            print(f"Unknown site '{args.site}'. Known: {', '.join(FOLDER_TO_DOMAIN)}", file=sys.stderr)
            sys.exit(2)
        targets = [domain]
    elif args.all:
        targets = [d for d in DOMAIN_TO_FOLDER if d in creds]
    else:
        print("Specify --site <folder> or --all", file=sys.stderr)
        sys.exit(2)

    ok = 0
    for domain in targets:
        if domain not in creds:
            print(f"\n=== {domain} ===\n  !! no creds in .env")
            continue
        if do_site(domain, creds[domain], mode):
            ok += 1
    print(f"\n{ok}/{len(targets)} site(s) {'listed' if mode == 'list' else 'uploaded'} OK.")
    sys.exit(0 if ok == len(targets) else 1)


if __name__ == "__main__":
    main()
