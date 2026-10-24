-- v4.18.4 存量修复：图片尺寸从 markdown 括号外移入括号内
-- 根因：v4.17 之前 MarkdownEditor 插入图片时把 ` =WxH` 写在 `)` 外面，
--       marked 的 imageSized 扩展只消费括号内的尺寸 → 尺寸泄漏为纯文本。
-- 修法：replace() 把 `) =WxH` 精确替换为 ` =WxH)`（幂等，重复执行无副作用）。
-- 影响面（v4.18.4 扫描）：subject_questions 4 行（id 67/68/71/72）+ quiz_questions 1 行（id 13）
UPDATE subject_questions SET content  = replace(content,  ') =396x232', ' =396x232)') WHERE id = 71;
UPDATE subject_questions SET content  = replace(content,  ') =396x185', ' =396x185)') WHERE id = 72;
UPDATE subject_questions SET answer   = replace(answer,   ') =308x73',  ' =308x73)')  WHERE id = 68;
UPDATE subject_questions SET analysis = replace(analysis, ') =308x92',  ' =308x92)')  WHERE id = 67;
UPDATE quiz_questions     SET answer   = replace(answer,   ') =308x73',  ' =308x73)')  WHERE id = 13;
