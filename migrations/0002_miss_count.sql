-- 0002: REMOVED 二次确认（missCount）
-- 背景：2026-09-04 事故——采集器漏抓一个类型（套餐 0 条）导致推送后 502 条
-- 在线资费被整体误判下线。根因已在采集端修复（严格齐全性门禁）+ 推送端
-- 增加分类归零闸门；本迁移是服务端最后一道防线：
--   连续 missCount 次未在抓取中出现才标记 OFFLINE + REMOVED 事件（阈值 2），
--   单次缺失仅累加 missCount、保持 ONLINE，杜绝单次抓取缺失→假下线事件。
ALTER TABLE Tariff ADD COLUMN missCount INTEGER NOT NULL DEFAULT 0;
