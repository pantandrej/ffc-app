-- ============================================================================
-- FANTASYСТА — Модуль 38. Финал личного зачёта (тур 9, 3-15 ноября)
-- По итогам групп (тур 8 = 5-й тур группы) место N группы A играет с местом N
-- группы B: 6 матчей за места 1-2, 3-4, 5-6, 7-8, 9-10, 11-12. Результат
-- матча, как и в группах, считается на фронтенде: больше очков за тур 9 —
-- победа. Пары зафиксированы по таблицам групп на момент окончания тура 8.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.solo_final_fixtures (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place        INTEGER NOT NULL UNIQUE CHECK (place BETWEEN 1 AND 6), -- место в группе = пара за места 2N-1 / 2N
  gameweek_id  INTEGER NOT NULL,
  profile_id_1 UUID NOT NULL REFERENCES public.fantasysta_profiles(id), -- группа A
  profile_id_2 UUID NOT NULL REFERENCES public.fantasysta_profiles(id)  -- группа B
);

ALTER TABLE public.solo_final_fixtures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS solo_final_fixtures_select ON public.solo_final_fixtures;
CREATE POLICY solo_final_fixtures_select ON public.solo_final_fixtures
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS solo_final_fixtures_admin_write ON public.solo_final_fixtures;
CREATE POLICY solo_final_fixtures_admin_write ON public.solo_final_fixtures
  FOR ALL TO authenticated USING (public.is_fantasysta_admin()) WITH CHECK (public.is_fantasysta_admin());
GRANT SELECT ON public.solo_final_fixtures TO authenticated;

INSERT INTO public.solo_final_fixtures (place, gameweek_id, profile_id_1, profile_id_2)
SELECT v.place, 9, a.profile_id, b.profile_id
FROM (VALUES
  (1, 'A', 1, 'B', 2),  -- dr.aseifeddine — Andrej Panteleew
  (2, 'A', 5, 'B', 1),  -- Клаудиньо — Гаптузо
  (3, 'A', 2, 'B', 5),  -- alexaraxela — Denis Poljakow
  (4, 'A', 6, 'B', 4),  -- Kirill Gadschiew — Serge Boev
  (5, 'A', 3, 'B', 3),  -- Antonio Golubew — Nikita Krikun
  (6, 'A', 4, 'B', 6)   -- adubrovin — Ilja Krikun
) AS v(place, ga, sa, gb, sb)
JOIN public.solo_group_members a ON a.group_label = v.ga AND a.seed = v.sa
JOIN public.solo_group_members b ON b.group_label = v.gb AND b.seed = v.sb
ON CONFLICT (place) DO UPDATE SET profile_id_1 = excluded.profile_id_1, profile_id_2 = excluded.profile_id_2;

-- Тур 9 продлён до 15 ноября (матчей клубов на 9-15 ноября в календаре нет).
UPDATE public.gameweeks SET ends_on = '2026-11-15' WHERE id = 9;

NOTIFY pgrst, 'reload schema';
