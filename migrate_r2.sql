-- ============================================================
-- 🔄 R2 迁移SQL：将所有 Supabase 存储 URL 替换为 /file/ 路径
-- ============================================================
-- 安全原则：
--   1. 仅替换包含 supabase.co/storage/v1/object/ 的 URL
--   2. 保留所有其他数据（dicebear 头像、外链等）不变
--   3. 逐表逐字段更新，可回滚
--   4. resources.file_path 存的是裸 key，无需替换
--
-- 用法:
--   npx wrangler d1 execute zhuiguang-db --remote --file=migrate_r2.sql
--
-- 回滚（如需）:
--   此迁移不可自动回滚（因为原始完整 URL 中的 bucket 名被丢弃）
--   但 /file/* 路由支持双线路：R2 未命中自动回退 Supabase
--   所以即使不执行此 SQL，旧文件仍可通过 Supabase URL 访问
-- ============================================================

-- ====== 1. users.avatar ======
-- 替换格式: https://xxx.supabase.co/storage/v1/object/public/zhuiguang/img_xxx.png → /file/img_xxx.png
UPDATE users
SET avatar = '/file/' || REPLACE(
  REPLACE(avatar, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', ''
)
WHERE avatar LIKE '%supabase.co/storage/v1/object/%';

-- ====== 2. articles.cover ======
UPDATE articles
SET cover = '/file/' || REPLACE(
  REPLACE(cover, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', ''
)
WHERE cover LIKE '%supabase.co/storage/v1/object/%';

-- ====== 3. articles.images (JSON 数组) ======
-- JSON 数组中的 URL 也需要替换
UPDATE articles
SET images = REPLACE(
  REPLACE(images, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/'
)
WHERE images LIKE '%supabase.co/storage/v1/object/%';

-- ====== 4. articles.content (Markdown 内容中的图片) ======
UPDATE articles
SET content = REPLACE(
  REPLACE(content, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/'
)
WHERE content LIKE '%supabase.co/storage/v1/object/%';

-- ====== 5. pages.cover ======
UPDATE pages
SET cover = '/file/' || REPLACE(
  REPLACE(cover, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', ''
)
WHERE cover LIKE '%supabase.co/storage/v1/object/%';

-- ====== 6. pages.images (JSON 数组) ======
UPDATE pages
SET images = REPLACE(
  REPLACE(images, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/'
)
WHERE images LIKE '%supabase.co/storage/v1/object/%';

-- ====== 7. pages.attachments (JSON 数组) ======
UPDATE pages
SET attachments = REPLACE(
  REPLACE(attachments, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/'
)
WHERE attachments LIKE '%supabase.co/storage/v1/object/%';

-- ====== 8. pages.content (Markdown 内容中的图片) ======
UPDATE pages
SET content = REPLACE(
  REPLACE(content, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/'
)
WHERE content LIKE '%supabase.co/storage/v1/object/%';

-- ====== 9. quiz_questions.attachments (JSON 数组) ======
UPDATE quiz_questions
SET attachments = REPLACE(
  REPLACE(attachments, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/'
)
WHERE attachments LIKE '%supabase.co/storage/v1/object/%';

-- ====== 10. subject_questions.attachments (JSON 数组) ======
UPDATE subject_questions
SET attachments = REPLACE(
  REPLACE(attachments, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/'
)
WHERE attachments LIKE '%supabase.co/storage/v1/object/%';

-- ====== 11. messages.attachments (JSON 数组) ======
UPDATE messages
SET attachments = REPLACE(
  REPLACE(attachments, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/'
)
WHERE attachments LIKE '%supabase.co/storage/v1/object/%';

-- ====== 12. article_comments.avatar ======
UPDATE article_comments
SET avatar = '/file/' || REPLACE(
  REPLACE(avatar, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', ''
)
WHERE avatar LIKE '%supabase.co/storage/v1/object/%';

-- ====== 13. page_comments.avatar ======
UPDATE page_comments
SET avatar = '/file/' || REPLACE(
  REPLACE(avatar, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', ''
)
WHERE avatar LIKE '%supabase.co/storage/v1/object/%';

-- ====== 14. resources.file_path（存的是裸 key，但也可能有完整 URL 的情况） ======
-- 仅当 file_path 是完整 Supabase URL 时才替换为裸 key
UPDATE resources
SET file_path = REPLACE(
  REPLACE(file_path, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''),
  'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', ''
)
WHERE file_path LIKE '%supabase.co/storage/v1/object/%';

-- ====== 验证：查询是否还有残留的 Supabase URL ======
SELECT 'users.avatar' AS field, COUNT(*) AS remaining FROM users WHERE avatar LIKE '%supabase.co%'
UNION ALL
SELECT 'articles.cover', COUNT(*) FROM articles WHERE cover LIKE '%supabase.co%'
UNION ALL
SELECT 'articles.images', COUNT(*) FROM articles WHERE images LIKE '%supabase.co%'
UNION ALL
SELECT 'articles.content', COUNT(*) FROM articles WHERE content LIKE '%supabase.co%'
UNION ALL
SELECT 'pages.cover', COUNT(*) FROM pages WHERE cover LIKE '%supabase.co%'
UNION ALL
SELECT 'pages.images', COUNT(*) FROM pages WHERE images LIKE '%supabase.co%'
UNION ALL
SELECT 'pages.attachments', COUNT(*) FROM pages WHERE attachments LIKE '%supabase.co%'
UNION ALL
SELECT 'pages.content', COUNT(*) FROM pages WHERE content LIKE '%supabase.co%'
UNION ALL
SELECT 'quiz_questions.attachments', COUNT(*) FROM quiz_questions WHERE attachments LIKE '%supabase.co%'
UNION ALL
SELECT 'subject_questions.attachments', COUNT(*) FROM subject_questions WHERE attachments LIKE '%supabase.co%'
UNION ALL
SELECT 'messages.attachments', COUNT(*) FROM messages WHERE attachments LIKE '%supabase.co%'
UNION ALL
SELECT 'article_comments.avatar', COUNT(*) FROM article_comments WHERE avatar LIKE '%supabase.co%'
UNION ALL
SELECT 'page_comments.avatar', COUNT(*) FROM page_comments WHERE avatar LIKE '%supabase.co%'
UNION ALL
SELECT 'resources.file_path', COUNT(*) FROM resources WHERE file_path LIKE '%supabase.co%';
