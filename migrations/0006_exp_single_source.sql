-- v4.11.0 经验值单一真源：以 exp_logs 为准校准 users.exp / users.level
--
-- 背景（这是一个真实发生过的数据一致性 bug）：
--   经验值长期存在两个数据源，靠手写代码同步，必然漂移 ——
--     · users.exp / users.level  —— 派生缓存，由 addExp 增量更新
--     · SUM(exp_logs.exp_change) —— 真实流水（唯一真源）
--   两个泄漏点导致永久性偏差：
--     1) PATCH /api/users/:id/exp 直接 `UPDATE users SET exp=?`，不写日志
--     2) 前端 saveExp() 同时执行 grantExp（写日志+增量）与 adjustUserExp（覆盖），
--        两条路径互相打架
--   叠加后果：/api/users（读日志）与 /api/leaderboard（读 users.exp）
--   同一人在两个页面显示不同数字。
--
-- 生产实测漂移（本次迁移前）：
--   id=1  admin    users.exp=375  日志和=360  差 +15
--   id=10 白楚涵    users.exp=10   日志和=20   差 -10
--   id=23 梁艺倩    users.exp=5    日志和=20   差 -15
--   id=51 张涵智    users.exp=5    日志和=20   差 -15
--
-- 本迁移为**全表幂等校准**：对每个用户按 SUM(exp_change) 重算缓存。
--   重复执行安全（结果相同）；即使将来出现新的漂移，重跑一次即可自愈。
-- 代码侧同步改造见 worker-api.ts 的 syncUserExp()。
--
-- 注意：level 公式与后端保持一致 —— floor(exp / 60) + 1，最低 1 级。

UPDATE users
   SET exp = MAX(0, COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE exp_logs.user_id = users.id), 0)),
       level = CAST(MAX(0, COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE exp_logs.user_id = users.id), 0)) / 60 AS INTEGER) + 1;
