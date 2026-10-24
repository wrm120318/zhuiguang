#!/usr/bin/env python3
"""v4.18.4 存量扫描：逐列查询（D1 复合 SELECT 上限低，逐条 --command 最稳）

用法：先 export CLOUDFLARE_API_TOKEN=<token>，再 python3 scripts/scan-img-size-leak.py
（wrangler 自行读取该环境变量，本脚本不持有任何凭证）
"""
import json
import os
import subprocess
import sys

NPX = "/root/.nvm/versions/node/v22.13.1/bin/npx"
CWD = "/workspace/zhuiguang"

LOCS = [
    ("subject_questions", "content"),
    ("subject_questions", "options"),
    ("subject_questions", "answer"),
    ("subject_questions", "analysis"),
    ("subject_questions", "attachments"),
    ("quiz_questions", "content"),
    ("quiz_questions", "options"),
    ("quiz_questions", "answer"),
    ("quiz_questions", "attachments"),
    ("quizzes", "description"),
    ("quizzes", "template"),
    ("quizzes", "export_config"),
    ("exams", "questions"),
    ("pages", "content"),
    ("pages", "attachments"),
    ("articles", "content"),
    ("notices", "content"),
    ("resources", "description"),
    ("practice_submissions", "answer"),
    ("question_feedback", "content"),
    ("question_favorites", "note"),
]


def count_one(table: str, col: str) -> int:
    sql = (f"SELECT COUNT(*) AS n FROM {table} "
           f"WHERE {col} LIKE '%) =%x%' OR {col} LIKE '%) =%×%'")
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
        print(f"{table}.{col} 查询失败 rc={out.returncode}:",
              (out.stdout or out.stderr)[:200], file=sys.stderr)
        return -1
    data = json.loads(out.stdout)
    return data[0]["results"][0]["n"]


hits = []
for t, c in LOCS:
    n = count_one(t, c)
    mark = "  <== 命中" if n > 0 else ""
    print(f"  {t}.{c}: {n}{mark}")
    if n > 0:
        hits.append((f"{t}.{c}", n))

print(f"\n=== 合计 {len(hits)} 处 / {sum(n for _, n in hits)} 行 ===")
