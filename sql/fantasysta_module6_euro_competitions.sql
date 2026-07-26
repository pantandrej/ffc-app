-- ============================================================================
-- FANTASYСТА — Модуль 6. Отметка еврокубков на карточке клуба
-- Добавляет колонку euro_competition (какой клуб играет в ЛЧ/ЛЕ/ЛК в этом
-- сезоне, если играет). Значения выставляются вручную админом — сами по себе
-- не считаются автоматически ни из tier, ни из league.
-- Выполнять в Supabase SQL Editor в любой момент после Модуля 2.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'euro_competition') THEN
    CREATE TYPE euro_competition AS ENUM ('ucl', 'uel', 'uecl');
  END IF;
END $$;

ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS euro_competition euro_competition;

NOTIFY pgrst, 'reload schema';
