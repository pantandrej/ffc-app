-- ============================================================================
-- FANTASYСТА — Модуль 15. Календарь по датам + отслеживание переносов матчей
--
-- Раньше club_fixtures жёстко привязывался к gameweek_id при добавлении.
-- Теперь принцип другой (как просил админ): матч просто имеет дату (kickoff_at),
-- а какому туру он принадлежит — вычисляется на лету по пересечению этой даты
-- с gameweeks.starts_on/ends_on. gameweek_id остаётся в схеме как необязательное
-- поле (на случай ручной привязки), но справочники/экраны им больше не пользуются.
--
-- Перенос матча: меняешь kickoff_at у существующей записи — триггер сам
-- проставляет status='postponed' и запоминает original_kickoff_at (самую первую
-- дату, даже если переносили несколько раз). Так видно и на экране игрока,
-- и в админке, что матч сдвинулся, и на какую дату он был раньше.
-- ============================================================================

ALTER TABLE public.club_fixtures ALTER COLUMN gameweek_id DROP NOT NULL;
ALTER TABLE public.club_fixtures ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE public.club_fixtures DROP CONSTRAINT IF EXISTS club_fixtures_status_check;
ALTER TABLE public.club_fixtures ADD CONSTRAINT club_fixtures_status_check CHECK (status IN ('scheduled', 'postponed'));
ALTER TABLE public.club_fixtures ADD COLUMN IF NOT EXISTS original_kickoff_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.mark_club_fixture_postponed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kickoff_at IS DISTINCT FROM OLD.kickoff_at THEN
    NEW.status := 'postponed';
    NEW.original_kickoff_at := COALESCE(OLD.original_kickoff_at, OLD.kickoff_at);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mark_club_fixture_postponed ON public.club_fixtures;
CREATE TRIGGER trg_mark_club_fixture_postponed
  BEFORE UPDATE ON public.club_fixtures
  FOR EACH ROW
  EXECUTE FUNCTION public.mark_club_fixture_postponed();

NOTIFY pgrst, 'reload schema';
