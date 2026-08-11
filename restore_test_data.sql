-- 恢复测试数据
-- 创建测试文章
INSERT INTO articles (title, content, user_id, actual_user_id, subject_id, category, status, likes, created_at) VALUES
('测试文章1', '这是一篇用于测试经验值系统的文章', 1, 44, 1, '散文', 'approved', 0, datetime('now','+8 hours')),
('测试文章2', '这是另一篇用于测试的文章', 1, 60, 1, '散文', 'approved', 0, datetime('now','+8 hours'));

-- 创建测试评论
INSERT INTO article_comments (article_id, user_id, content, status, created_at) VALUES
(100, 44, '这是一条测试评论', 'approved', datetime('now','+8 hours'));

-- 查看结果
SELECT '文章数量:', COUNT(*) FROM articles;
SELECT '评论数量:', COUNT(*) FROM article_comments;
