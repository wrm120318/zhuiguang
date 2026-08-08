import os, sys, re, time, base64, json, hashlib, subprocess, urllib.request
PROXY = os.environ.get("http_proxy") or os.environ.get("HTTP_PROXY") or "http://127.0.0.1:18080"
WORK_DIR = "/workspace"
TMP_DIR = "/tmp/ult"
GITHUB_TOKEN = ""
try:
    for line in open(f"{WORK_DIR}/.env"):
        line=line.strip()
        if line.startswith("GITHUB_TOKEN="):
            GITHUB_TOKEN = line.split("=",1)[1].strip().strip('"').strip("'")
except: pass

def sh(cmd, t=15):
    env = os.environ.copy()
    for k in ["http_proxy","https_proxy","HTTP_PROXY","HTTPS_PROXY"]: env[k]=PROXY
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t, env=env)
        return (r.stdout+r.stderr).strip()
    except: return "__ERR__"

# 1. 从所有tun_*.log抓URL
all_urls=set()
for fn in sorted(os.listdir(TMP_DIR)) if os.path.exists(TMP_DIR) else []:
    if not re.match(r"tun_\d+\.log", fn): continue
    try:
        for line in open(os.path.join(TMP_DIR, fn)).read().splitlines()[-80:]:
            for u in re.findall(r"https://[A-Za-z0-9\-]+\.(?:free\.pinggy\.net|run\.pinggy-free\.link)", line):
                all_urls.add(u.rstrip("/"))
    except: pass

# 2. 走代理curl验HTTP200
live=[]
for u in sorted(all_urls):
    code = sh(f"curl -s --max-time 7 -x {PROXY} -o /dev/null -w '%{{http_code}}' -H 'User-Agent: Zhuiguang-NDGv4/1.0' -H 'X-Pinggy-No-Screen: 1' '{u}/__zg_health'")
    if code.strip() == "200": live.append(u)

# 3. MD5 + stdout（给bash端判断是否变化）
content = "\n".join(sorted(set(live))) + "\n" if live else ""
md5 = hashlib.md5(content.encode()).hexdigest()
cnt = len(live)
print(f"LIVE:{cnt}")
print(f"MD5:{md5}")

# 4. 写本地 + 写GitHub（只在真活>=1时写）
if cnt >= 1:
    with open(f"{TMP_DIR}/live.txt","w") as f: f.write(content)
    # 写GitHub（用token）
    if GITHUB_TOKEN:
        out = sh(f"curl -s --max-time 12 -x {PROXY} -H 'Authorization: token {GITHUB_TOKEN}' -H 'Accept: application/vnd.github.v3+json' 'https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt'")
        sha = ""
        try:
            d = json.loads(out)
            if isinstance(d, dict): sha = d.get("sha","")
        except: pass
        if sha:
            b64 = base64.b64encode(content.encode()).decode()
            body = {"message": f"🛡️ NDGv4:真活={cnt}条(55分主动刷新SSH+假死URL自动剔除)", "content": b64, "sha": sha}
            bf = f"{TMP_DIR}/_gh_body.json"
            with open(bf,"w") as f: json.dump(body, f)
            sh(f"""curl -s --max-time 20 -x {PROXY} -X PUT -H 'Authorization: token {GITHUB_TOKEN}' -H 'Accept: application/vnd.github.v3+json' -H 'Content-Type: application/json' --data-binary @{bf} 'https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt'""", t=22)
