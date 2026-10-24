#!/usr/bin/env python3
"""v4.18.4 拉取命中行并核对匹配上下文（dry-run，不写库）

用法：先 export CLOUDFLARE_API_TOKEN=<token>，再 python3 scripts/dump-img-size-hits.py
（wrangler 自行读取该环境变量，本脚本不持有任何凭证）
"""
import json
import os
import re
import subprocess
import sys

NPX = "/root/.nvm/versions/node/v22.13.1/bin/npx"
CWD = "/workspace/zhuiguang"

PAT = re.compile(r"\)\s*=\s*(\d{1,5})\s*[x×]\s*(\d{1,5})")

QUERIES = [
    ("subject_questions", "id", "content",
     "SELECT id, qtype, content FROM subject_questions WHERE content LIKE '%) =%x%' OR content LIKE '%) =%×%'"),
    ("subject_questions", "id", "answer",
     "SELECT id, answer FROM subject_questions WHERE answer LIKE '%) =%x%' OR answer LIKE '%) =%×%'"),
    ("subject_questions", "id", "analysis",
     "SELECT id, analysis FROM subject_questions WHERE analysis LIKE '%) =%x%' OR analysis LIKE '%) =%×%'"),
    ("quiz_questions", "id", "answer",
     "SELECT id, answer FROM quiz_questions WHERE answer LIKE '%) =%x%' OR answer LIKE '%) =%×%'"),
]


def run(sql: str):
    out = subprocess.run(
        [NPX, "wrangler", "d1", "execute", "zhuiguang-db", "--remote",
         "--command", sql, "--json"],
        capture_output=True, text=True,
        env={**os.environ,
             "PATH": "/root/.nvm/versions/node/v22.13.1/bin:/usr/local/bin:/usr/bin:/bin",
             "HOME": "/root"},
        cwd=CWD,
    )
    if out.returncode != 0:
        print("查询失败:", (out.stdout or out.stderr)[:300], file=sys.stderr)
        sys.exit(1)
    return json.loads(out.stdout)[0]["results"]


total = 0
for table, idcol, col, sql in QUERIES:
    rows = run(sql)
    if not rows:
        continue
    for row in rows:
        text = row.get(col) or ""
        rid = row.get(idcol)
        for m in PAT.finditer(text):
            total += 1
            s = max(0, m.start() - 70)
            e = min(len(text), m.end() + 40)
            ctx = text[s:e].replace("\n", "\\n")
            print(f"[{table}.{col} id={rid}] 匹配 {m.group(0)!r} -> 将改为 ' ={m.group(1)}x{m.group(2)})'")
            print(f"    上下文: …{ctx}…")
print(f"\n=== 共 {total} 处匹配待修复 ===")
