-- FFC: права для 3-го тура и плей-офф-пар
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.ffc_round3_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  answers JSONB NOT NULL,
  questions JSONB,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ffc_round3_official_answers (
  question_no INTEGER PRIMARY KEY,
  answer TEXT NOT NULL CHECK (answer IN ('Да','Нет')),
  points INTEGER NOT NULL DEFAULT 2,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.ffc_round3_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ffc_round3_official_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ffc_round3_answers_public_insert" ON public.ffc_round3_answers;
DROP POLICY IF EXISTS "ffc_round3_answers_public_select" ON public.ffc_round3_answers;
DROP POLICY IF EXISTS "ffc_round3_answers_admin_select" ON public.ffc_round3_answers;
CREATE POLICY "ffc_round3_answers_public_insert"
ON public.ffc_round3_answers FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "ffc_round3_answers_public_select"
ON public.ffc_round3_answers FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "ffc_round3_official_public_select" ON public.ffc_round3_official_answers;
DROP POLICY IF EXISTS "ffc_round3_official_admin_write" ON public.ffc_round3_official_answers;
CREATE POLICY "ffc_round3_official_public_select"
ON public.ffc_round3_official_answers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "ffc_round3_official_admin_write"
ON public.ffc_round3_official_answers FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON public.ffc_round3_answers TO anon, authenticated;
GRANT SELECT ON public.ffc_round3_official_answers TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.ffc_round3_official_answers TO authenticated;

CREATE TABLE IF NOT EXISTS public.playoff_official_pairs (
  match_id TEXT PRIMARY KEY,
  home_team TEXT,
  away_team TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.playoff_official_pairs
  ALTER COLUMN home_team DROP NOT NULL,
  ALTER COLUMN away_team DROP NOT NULL;
ALTER TABLE public.playoff_official_pairs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pop_select" ON public.playoff_official_pairs;
DROP POLICY IF EXISTS "pop_insert" ON public.playoff_official_pairs;
DROP POLICY IF EXISTS "pop_update" ON public.playoff_official_pairs;
DROP POLICY IF EXISTS "pop_delete" ON public.playoff_official_pairs;
CREATE POLICY "pop_select" ON public.playoff_official_pairs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "pop_insert" ON public.playoff_official_pairs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "pop_update" ON public.playoff_official_pairs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "pop_delete" ON public.playoff_official_pairs FOR DELETE TO authenticated USING (true);

GRANT SELECT ON public.playoff_official_pairs TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.playoff_official_pairs TO authenticated;

NOTIFY pgrst, 'reload schema';
