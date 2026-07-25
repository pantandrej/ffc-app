import { createClient } from "@supabase/supabase-js";

// Тот же Supabase-проект, что и у старого прогнозиста (см. src/App.jsx) —
// FANTASYСТА живёт на том же деплое, поэтому ключи те же самые.
const SUPABASE_URL = "https://gcuxixbldjrztnqsdqcs.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdjdXhpeGJsZGpyenRucXNkcWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDU1ODMsImV4cCI6MjA5NTM4MTU4M30.f6LGTZyW1qDyZ0urE0atzABmyAjQ9p8gAkinyu7j5h8";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
