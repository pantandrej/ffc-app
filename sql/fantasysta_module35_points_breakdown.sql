-- ============================================================================
-- FANTASYСТА — Модуль 35. Разбивка очков, когда клуб играл дважды за тур
-- club_results хранит один агрегированный результат на клуб за тур (см.
-- модуль 34 и комментарии к ручным правкам тура 3) — при двух матчах
-- (еврокубок + чемпионат) total_points уже был суммой, но на карточке
-- "Твой состав на N-й тур" это выглядело как одна обычная игра. Добавляем
-- текстовое поле "8+7" — тур для отображения разбивки, не участвует в
-- расчёте очков (это по-прежнему делает total_points).
-- ============================================================================

ALTER TABLE public.club_results
  ADD COLUMN IF NOT EXISTS points_breakdown TEXT;

-- Тур 3 — клубы с двумя матчами (еврокубок + чемпионат), суммированными в module ad-hoc правках:
UPDATE public.club_results SET points_breakdown = '6+1'
  WHERE gameweek_id = 3 AND club_id = 'de6cf6e6-dab3-42ba-8ccf-62c0863e2873'; -- Астон Вилла: ЛЧ 6 + АПЛ 1
UPDATE public.club_results SET points_breakdown = '10+5'
  WHERE gameweek_id = 3 AND club_id = 'e7c06f07-7616-4625-af1c-71f589bdbba7'; -- Бавария: ЛЧ 10 + Бундеслига 5
UPDATE public.club_results SET points_breakdown = '8+7'
  WHERE gameweek_id = 3 AND club_id = 'f40457fd-950a-46a8-9c7d-74ce15bb43f8'; -- Барселона: ЛЧ 8 + Ла Лига 7
UPDATE public.club_results SET points_breakdown = '2+7'
  WHERE gameweek_id = 3 AND club_id = 'f793de60-be5b-4967-82eb-1e94093747e5'; -- Лилль: ЛЧ 2 + Лига 1 7
UPDATE public.club_results SET points_breakdown = '9+6'
  WHERE gameweek_id = 3 AND club_id = '61d575b0-aca4-4edf-88de-fb07469c0a07'; -- ПСЖ: ЛЧ 9 + Лига 1 6
UPDATE public.club_results SET points_breakdown = '7+6'
  WHERE gameweek_id = 3 AND club_id = 'd5703f69-8c58-4ca5-bc0b-8f63a85179de'; -- Манчестер Сити: ЛЧ 7 + АПЛ 6
UPDATE public.club_results SET points_breakdown = '5+7'
  WHERE gameweek_id = 3 AND club_id = '685c7814-afd4-4418-a47f-1bf2ea765daf'; -- Реал Мадрид: ЛЧ 5 + Ла Лига 7

NOTIFY pgrst, 'reload schema';
