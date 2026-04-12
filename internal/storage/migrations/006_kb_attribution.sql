-- 006_kb_attribution.sql — track which principal created/promoted a card.
ALTER TABLE kb_card ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
