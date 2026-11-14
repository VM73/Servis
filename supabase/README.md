# supabase/ – záloha sdíleného projektu

Supabase projekt **servisní záznamy** (`pqehuuamgecmdmrdhmza`) sdílí tři appky:
Servisní záznamy (toto repo), Klima postupy (VM73/Klima) a Kuchařka.
Proto je jeho záloha celá tady, i pro Klimu a Kuchařku.

| Soubor | Co obsahuje |
|---|---|
| `schema.sql` | tabulky, omezení, indexy, funkce, triggery, RLS politiky, Storage buckety a jejich politiky |
| `functions/servis/index.ts` | Edge Function `servis` – diktát ze Siri zkratky, přepis pole, cesta zpět (OpenAI) |
| `functions/klima/index.ts` | Edge Function `klima` – rozdělení nadiktovaného postupu do kroků |
| `functions/kucharka/index.ts` | Edge Function `kucharka` – přepis receptu z fotek (Claude / OpenAI) |

Snímek stažen 2026-11-14 čtením přes konektor Supabase – v Supabase se nic neměnilo.
Kód funkcí je přepsán z výpisu konektoru; před prvním nasazením z repa ho porovnej
s editorem v Supabase (Edge Functions → funkce → Code).

**Žádná data ani klíče.** Secrets (OPENAI_API_KEY, ANTHROPIC_API_KEY, SHORTCUT_TOKEN,
OWNER_USER_ID, …) jsou jen v Supabase → Edge Functions → Secrets.

## Pravidlo pro další změny
1. Změnu databáze napsat jako nový soubor `migrations/RRRRMMDDHHMM_popis.sql`.
2. Spustit v Supabase (SQL Editor) a ověřit druhým uživatelem (RLS).
3. Obnovit `schema.sql` (nechat Clauda stáhnout znovu).
4. Změnu Edge Function nejdřív v repu, pak nasadit – ne naopak.
