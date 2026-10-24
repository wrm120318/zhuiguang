-- v4.18.4 存量扫描：markdown 图片尺寸泄漏 `) =WxH`（尺寸写在括号外的坏格式）
-- D1 复合 SELECT 上限低，改用多条独立语句一次提交（wrangler 返回结果数组）
SELECT 'subject_questions.content' AS loc, COUNT(*) AS n FROM subject_questions WHERE content LIKE '%) =%x%' OR content LIKE '%) =%×%';
SELECT 'subject_questions.options' AS loc, COUNT(*) AS n FROM subject_questions WHERE options LIKE '%) =%x%' OR options LIKE '%) =%×%';
SELECT 'subject_questions.answer' AS loc, COUNT(*) AS n FROM subject_questions WHERE answer LIKE '%) =%x%' OR answer LIKE '%) =%×%';
SELECT 'subject_questions.analysis' AS loc, COUNT(*) AS n FROM subject_questions WHERE analysis LIKE '%) =%x%' OR analysis LIKE '%) =%×%';
SELECT 'subject_questions.attachments' AS loc, COUNT(*) AS n FROM subject_questions WHERE attachments LIKE '%) =%x%' OR attachments LIKE '%) =%×%';
SELECT 'quiz_questions.content' AS loc, COUNT(*) AS n FROM quiz_questions WHERE content LIKE '%) =%x%' OR content LIKE '%) =%×%';
SELECT 'quiz_questions.options' AS loc, COUNT(*) AS n FROM quiz_questions WHERE options LIKE '%) =%x%' OR options LIKE '%) =%×%';
SELECT 'quiz_questions.answer' AS loc, COUNT(*) AS n FROM quiz_questions WHERE answer LIKE '%) =%x%' OR answer LIKE '%) =%×%';
SELECT 'quiz_questions.attachments' AS loc, COUNT(*) AS n FROM quiz_questions WHERE attachments LIKE '%) =%x%' OR attachments LIKE '%) =%×%';
SELECT 'quizzes.description' AS loc, COUNT(*) AS n FROM quizzes WHERE description LIKE '%) =%x%' OR description LIKE '%) =%×%';
SELECT 'quizzes.template' AS loc, COUNT(*) AS n FROM quizzes WHERE template LIKE '%) =%x%' OR template LIKE '%) =%×%';
SELECT 'quizzes.export_config' AS loc, COUNT(*) AS n FROM quizzes WHERE export_config LIKE '%) =%x%' OR export_config LIKE '%) =%×%';
SELECT 'exams.questions' AS loc, COUNT(*) AS n FROM exams WHERE questions LIKE '%) =%x%' OR questions LIKE '%) =%×%';
SELECT 'pages.content' AS loc, COUNT(*) AS n FROM pages WHERE content LIKE '%) =%x%' OR content LIKE '%) =%×%';
SELECT 'pages.attachments' AS loc, COUNT(*) AS n FROM pages WHERE attachments LIKE '%) =%x%' OR attachments LIKE '%) =%×%';
SELECT 'articles.content' AS loc, COUNT(*) AS n FROM articles WHERE content LIKE '%) =%x%' OR content LIKE '%) =%×%';
SELECT 'notices.content' AS loc, COUNT(*) AS n FROM notices WHERE content LIKE '%) =%x%' OR content LIKE '%) =%×%';
SELECT 'resources.description' AS loc, COUNT(*) AS n FROM resources WHERE description LIKE '%) =%x%' OR description LIKE '%) =%×%';
SELECT 'practice_submissions.answer' AS loc, COUNT(*) AS n FROM practice_submissions WHERE answer LIKE '%) =%x%' OR answer LIKE '%) =%×%';
SELECT 'question_feedback.content' AS loc, COUNT(*) AS n FROM question_feedback WHERE content LIKE '%) =%x%' OR content LIKE '%) =%×%';
SELECT 'question_favorites.note' AS loc, COUNT(*) AS n FROM question_favorites WHERE note LIKE '%) =%x%' OR note LIKE '%) =%×%';
