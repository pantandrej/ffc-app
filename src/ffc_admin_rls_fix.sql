CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- 1) Официальные счета матчей
CREATE TABLE IF NOT EXISTS public.official_results (
  match_id TEXT PRIMARY KEY,
  home_score INTEGER,
  away_score INTEGER,
  penalty_winner TEXT,
  status TEXT DEFAULT 'draft',
  source TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.official_results ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.official_results TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.official_results TO authenticated;
DROP POLICY IF EXISTS "or_select" ON public.official_results;
DROP POLICY IF EXISTS "or_insert" ON public.official_results;
DROP POLICY IF EXISTS "or_update" ON public.official_results;
DROP POLICY IF EXISTS "or_delete" ON public.official_results;
CREATE POLICY "or_select" ON public.official_results FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "or_insert" ON public.official_results FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "or_update" ON public.official_results FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "or_delete" ON public.official_results FOR DELETE TO authenticated USING (true);

-- 2) Бонусные официальные ответы
CREATE TABLE IF NOT EXISTS public.bonus_official_answers (
  question_id TEXT PRIMARY KEY,
  answer JSONB,
  points INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.bonus_official_answers ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0;
ALTER TABLE public.bonus_official_answers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE public.bonus_official_answers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.bonus_official_answers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.bonus_official_answers TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.bonus_official_answers TO authenticated;
DROP POLICY IF EXISTS "boa_select" ON public.bonus_official_answers;
DROP POLICY IF EXISTS "boa_insert" ON public.bonus_official_answers;
DROP POLICY IF EXISTS "boa_update" ON public.bonus_official_answers;
DROP POLICY IF EXISTS "boa_delete" ON public.bonus_official_answers;
CREATE POLICY "boa_select" ON public.bonus_official_answers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "boa_insert" ON public.bonus_official_answers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "boa_update" ON public.bonus_official_answers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "boa_delete" ON public.bonus_official_answers FOR DELETE TO authenticated USING (true);

-- 3) Очки игроков 1-го тура / составов
CREATE TABLE IF NOT EXISTS public.ffc_round_player_scores (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  round_id UUID REFERENCES public.ffc_rounds(id),
  player_id TEXT NOT NULL,
  points INTEGER DEFAULT 0,
  player_name TEXT,
  national_team TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by UUID,
  UNIQUE(round_id, player_id)
);
ALTER TABLE public.ffc_round_player_scores ADD COLUMN IF NOT EXISTS player_name TEXT;
ALTER TABLE public.ffc_round_player_scores ADD COLUMN IF NOT EXISTS national_team TEXT;
ALTER TABLE public.ffc_round_player_scores ADD COLUMN IF NOT EXISTS updated_by UUID;
ALTER TABLE public.ffc_round_player_scores ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.ffc_round_player_scores TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.ffc_round_player_scores TO authenticated;
DROP POLICY IF EXISTS "rps_select" ON public.ffc_round_player_scores;
DROP POLICY IF EXISTS "rps_insert" ON public.ffc_round_player_scores;
DROP POLICY IF EXISTS "rps_update" ON public.ffc_round_player_scores;
DROP POLICY IF EXISTS "rps_delete" ON public.ffc_round_player_scores;
CREATE POLICY "rps_select" ON public.ffc_round_player_scores FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "rps_insert" ON public.ffc_round_player_scores FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "rps_update" ON public.ffc_round_player_scores FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "rps_delete" ON public.ffc_round_player_scores FOR DELETE TO authenticated USING (true);

-- 4) Реальные пары плей-офф
CREATE TABLE IF NOT EXISTS public.playoff_official_pairs (
  match_id TEXT PRIMARY KEY,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.playoff_official_pairs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.playoff_official_pairs TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.playoff_official_pairs TO authenticated;
DROP POLICY IF EXISTS "pop_select" ON public.playoff_official_pairs;
DROP POLICY IF EXISTS "pop_insert" ON public.playoff_official_pairs;
DROP POLICY IF EXISTS "pop_update" ON public.playoff_official_pairs;
DROP POLICY IF EXISTS "pop_delete" ON public.playoff_official_pairs;
CREATE POLICY "pop_select" ON public.playoff_official_pairs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "pop_insert" ON public.playoff_official_pairs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "pop_update" ON public.playoff_official_pairs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "pop_delete" ON public.playoff_official_pairs FOR DELETE TO authenticated USING (true);

-- 5) Официальные ответы 3-го тура 1 на 1
CREATE TABLE IF NOT EXISTS public.ffc_round3_official_answers (
  question_no INTEGER PRIMARY KEY,
  answer TEXT NOT NULL CHECK (answer IN ('Да','Нет')),
  points INTEGER DEFAULT 2,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.ffc_round3_official_answers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.ffc_round3_official_answers TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.ffc_round3_official_answers TO authenticated;
DROP POLICY IF EXISTS "ffc_round3_official_public_select" ON public.ffc_round3_official_answers;
DROP POLICY IF EXISTS "ffc_round3_official_admin_write" ON public.ffc_round3_official_answers;
CREATE POLICY "ffc_round3_official_public_select" ON public.ffc_round3_official_answers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "ffc_round3_official_admin_write" ON public.ffc_round3_official_answers FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
