-- ============================================================
-- 🔄 R2 迁移SQL：将所有 Supabase 存储 URL 替换为 /file/ 路径
-- 仅替换包含 supabase.co/storage/v1/object/ 的 URL，保留所有其他数据
-- ============================================================

-- 1. users.avatar
UPDATE users SET avatar = '/file/' || REPLACE(REPLACE(avatar, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '') WHERE avatar LIKE '%supabase.co/storage/v1/object/%';

-- 2. articles.cover
UPDATE articles SET cover = '/file/' || REPLACE(REPLACE(cover, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '') WHERE cover LIKE '%supabase.co/storage/v1/object/%';

-- 3. articles.images (JSON 数组)
UPDATE articles SET images = REPLACE(REPLACE(images, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/') WHERE images LIKE '%supabase.co/storage/v1/object/%';

-- 4. articles.content (Markdown 图片)
UPDATE articles SET content = REPLACE(REPLACE(content, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/') WHERE content LIKE '%supabase.co/storage/v1/object/%';

-- 5. pages.cover
UPDATE pages SET cover = '/file/' || REPLACE(REPLACE(cover, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '') WHERE cover LIKE '%supabase.co/storage/v1/object/%';

-- 6. pages.images (JSON 数组)
UPDATE pages SET images = REPLACE(REPLACE(images, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/') WHERE images LIKE '%supabase.co/storage/v1/object/%';

-- 7. pages.attachments (JSON 数组)
UPDATE pages SET attachments = REPLACE(REPLACE(attachments, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/') WHERE attachments LIKE '%supabase.co/storage/v1/object/%';

-- 8. pages.content (Markdown 图片)
UPDATE pages SET content = REPLACE(REPLACE(content, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/') WHERE content LIKE '%supabase.co/storage/v1/object/%';

-- 9. quiz_questions.attachments
UPDATE quiz_questions SET attachments = REPLACE(REPLACE(attachments, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/') WHERE attachments LIKE '%supabase.co/storage/v1/object/%';

-- 10. subject_questions.attachments
UPDATE subject_questions SET attachments = REPLACE(REPLACE(attachments, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/') WHERE attachments LIKE '%supabase.co/storage/v1/object/%';

-- 11. messages.attachments
UPDATE messages SET attachments = REPLACE(REPLACE(attachments, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', '/file/'), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '/file/') WHERE attachments LIKE '%supabase.co/storage/v1/object/%';

-- 12. article_comments.avatar
UPDATE article_comments SET avatar = '/file/' || REPLACE(REPLACE(avatar, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '') WHERE avatar LIKE '%supabase.co/storage/v1/object/%';

-- 13. page_comments.avatar
UPDATE page_comments SET avatar = '/file/' || REPLACE(REPLACE(avatar, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '') WHERE avatar LIKE '%supabase.co/storage/v1/object/%';

-- 14. resources.file_path（仅当是完整 URL 时替换为裸 key）
UPDATE resources SET file_path = REPLACE(REPLACE(file_path, 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/public/zhuiguang/', ''), 'https://njwkkinzgmwzyfifagwl.supabase.co/storage/v1/object/sign/zhuiguang/', '') WHERE file_path LIKE '%supabase.co/storage/v1/object/%';
