-- ============================================================================
-- FANTASYСТА — Модуль 30. Еврокубковые матчи с соперником не из наших 96 клубов
-- club_fixtures раньше требовал ОБА клуба как FK на clubs(id) — поэтому матч
-- любого нашего клуба против клуба не из топ-5 лиг (Брюгге, Фейеноорд,
-- Бенфика и т.п.) физически нельзя было занести. Теперь home_club_id и
-- away_club_id опциональны — если соперник не наш, вместо club_id пишем его
-- имя в home_opponent_name/away_opponent_name. Ровно одно поле из пары
-- (club_id, opponent_name) должно быть заполнено — это гарантирует CHECK.
-- ============================================================================

ALTER TABLE public.club_fixtures ALTER COLUMN home_club_id DROP NOT NULL;
ALTER TABLE public.club_fixtures ALTER COLUMN away_club_id DROP NOT NULL;
ALTER TABLE public.club_fixtures ADD COLUMN IF NOT EXISTS home_opponent_name TEXT;
ALTER TABLE public.club_fixtures ADD COLUMN IF NOT EXISTS away_opponent_name TEXT;

ALTER TABLE public.club_fixtures DROP CONSTRAINT IF EXISTS club_fixtures_check;
ALTER TABLE public.club_fixtures ADD CONSTRAINT club_fixtures_home_xor_check
  CHECK ((home_club_id IS NOT NULL) <> (home_opponent_name IS NOT NULL));
ALTER TABLE public.club_fixtures ADD CONSTRAINT club_fixtures_away_xor_check
  CHECK ((away_club_id IS NOT NULL) <> (away_opponent_name IS NOT NULL));
ALTER TABLE public.club_fixtures ADD CONSTRAINT club_fixtures_distinct_check
  CHECK (home_club_id IS NULL OR away_club_id IS NULL OR home_club_id <> away_club_id);

NOTIFY pgrst, 'reload schema';
