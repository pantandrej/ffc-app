-- ============================================================================
-- FANTASYСТА — Модуль 36. Группы личного зачёта (плей-офф топ-12)
-- Топ-12 личного зачёта (по итогам тура 3, завершён 15 сентября — состав
-- финальный) разбиты змейкой на 2 группы по 6: группа A — места
-- 1,4,5,8,9,12; группа B — места 2,3,6,7,10,11. Внутри группы — круговой
-- турнир "каждый с каждым" (5 туров = 5 соперников), 1 общий тур игры лиги =
-- 1 тур группы: тур 4→раунд1, 5→раунд2, 6→раунд3, 7→раунд4, 8→раунд5.
-- Тур 9 — финал (пара определится по итогам групп, здесь не фиксируется).
-- Результат матча группы считается на фронтенде по факту: сравниваются очки
-- обоих игроков за тот тур (leaderboard_solo_by_tour) — больше очков выиграл.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.solo_group_members (
  group_label TEXT NOT NULL CHECK (group_label IN ('A', 'B')),
  seed        INTEGER NOT NULL CHECK (seed BETWEEN 1 AND 6),
  profile_id  UUID NOT NULL REFERENCES public.fantasysta_profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (group_label, seed)
);

CREATE TABLE IF NOT EXISTS public.solo_group_fixtures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_label   TEXT NOT NULL CHECK (group_label IN ('A', 'B')),
  round         INTEGER NOT NULL CHECK (round BETWEEN 1 AND 5),
  -- Без FK на gameweeks — туры 5-8 ещё не заведены на момент создания
  -- расписания групп (заводятся администратором по мере игры сезона).
  gameweek_id   INTEGER NOT NULL,
  profile_id_1  UUID NOT NULL REFERENCES public.fantasysta_profiles(id),
  profile_id_2  UUID NOT NULL REFERENCES public.fantasysta_profiles(id)
);

ALTER TABLE public.solo_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solo_group_fixtures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS solo_group_members_select ON public.solo_group_members;
CREATE POLICY solo_group_members_select ON public.solo_group_members
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS solo_group_members_admin_write ON public.solo_group_members;
CREATE POLICY solo_group_members_admin_write ON public.solo_group_members
  FOR ALL TO authenticated USING (public.is_fantasysta_admin()) WITH CHECK (public.is_fantasysta_admin());

DROP POLICY IF EXISTS solo_group_fixtures_select ON public.solo_group_fixtures;
CREATE POLICY solo_group_fixtures_select ON public.solo_group_fixtures
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS solo_group_fixtures_admin_write ON public.solo_group_fixtures;
CREATE POLICY solo_group_fixtures_admin_write ON public.solo_group_fixtures
  FOR ALL TO authenticated USING (public.is_fantasysta_admin()) WITH CHECK (public.is_fantasysta_admin());

GRANT SELECT ON public.solo_group_members, public.solo_group_fixtures TO authenticated;

-- ---------------------------------------------------------------------------
-- Состав групп — змейка 1,4,5,8,9,12 / 2,3,6,7,10,11 по итоговому личному
-- зачёту ПОСЛЕ тура 3 (тур завершён 15 сентября — состав финальный).
-- ---------------------------------------------------------------------------
INSERT INTO public.solo_group_members (group_label, seed, profile_id) VALUES
  ('A', 1, 'd73d5238-d27d-4f86-9e78-c51d1ec97a49'), -- dr.aseifeddine (место 1)
  ('A', 2, 'df97ee31-9a87-4462-933d-53e03c1c5bec'), -- alexaraxela (место 4)
  ('A', 3, '25fd6c0c-f0a9-474b-aaea-53e653683fac'), -- Antonio Golubew (место 5)
  ('A', 4, '611862c5-8a70-4bf8-83fd-7564bb1e0454'), -- adubrovin (место 8)
  ('A', 5, 'a0000000-0000-0000-0000-00000000c1a2'), -- Клаудиньо (место 9)
  ('A', 6, '9ad91b73-5b4b-41e5-a0ad-34aef10c7a14'), -- Kirill Gadschiew (место 12)
  ('B', 1, 'a0000000-0000-0000-0000-00000000c6a1'), -- Гаптузо (место 2)
  ('B', 2, 'b7063b65-f51e-4e66-9cef-66d4a52a65ad'), -- Andrej Panteleew (место 3)
  ('B', 3, 'ff2ef5ef-01c4-48e0-839b-e71964fdc4b7'), -- Nikita Krikun (место 6)
  ('B', 4, '5c60b40d-e1f6-436c-981e-5b9f9b67185e'), -- Serge Boev (место 7)
  ('B', 5, 'f96c6702-ea9e-4205-ad74-70e63ef37695'), -- Denis Poljakow (место 10)
  ('B', 6, 'bcf7b782-d48d-4576-abfc-e10362eb6354')  -- Ilja Krikun (место 11)
ON CONFLICT (group_label, seed) DO UPDATE SET profile_id = excluded.profile_id;

-- ---------------------------------------------------------------------------
-- Календарь "каждый с каждым" (метод круга, 6 участников, 5 туров) —
-- одинаковая структура пар по seed для обеих групп.
-- ---------------------------------------------------------------------------
INSERT INTO public.solo_group_fixtures (group_label, round, gameweek_id, profile_id_1, profile_id_2)
SELECT g.group_label, r.round, r.gameweek_id, m1.profile_id, m2.profile_id
FROM (VALUES
  (1, 4, 1, 6), (1, 4, 2, 5), (1, 4, 3, 4),
  (2, 5, 5, 6), (2, 5, 1, 4), (2, 5, 2, 3),
  (3, 6, 4, 6), (3, 6, 3, 5), (3, 6, 1, 2),
  (4, 7, 3, 6), (4, 7, 2, 4), (4, 7, 1, 5),
  (5, 8, 2, 6), (5, 8, 1, 3), (5, 8, 4, 5)
) AS r(round, gameweek_id, seed1, seed2)
CROSS JOIN (SELECT DISTINCT group_label FROM public.solo_group_members) g
JOIN public.solo_group_members m1 ON m1.group_label = g.group_label AND m1.seed = r.seed1
JOIN public.solo_group_members m2 ON m2.group_label = g.group_label AND m2.seed = r.seed2;

NOTIFY pgrst, 'reload schema';
