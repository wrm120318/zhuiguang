-- v4.9.7 新增 ADMIN 角色（每人独立权限）
-- users.permissions：JSON 数组字符串，如 ["users","audit"]，仅 role='ADMIN' 有意义。
-- NULL / 空串 / 非法 JSON 一律解析为 []。
-- SUPER_ADMIN 不读该列，恒全权。
-- 由 ADMIN 降级为其他角色时，后端会将该列置回 NULL。

ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT NULL;
