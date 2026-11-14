// Supabase Edge Function "klima" – rozdělí nadiktovaný postup do polí
// Volá ji appka Klima postupy s přihlášením uživatele (JWT).
// Secrets: OPENAI_API_KEY (už je v projektu ze Servisu). Verify JWT: VYPNUTO (ověřujeme sami).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const odpoved = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const MODEL = "gpt-4.1-mini";

const SCHEMA = {
  name: "postup",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      vyrobce: { type: "string", description: "Výrobce; když odpovídá existujícímu, přesně jeho zápis; jinak prázdné" },
      nazev: { type: "string", description: "Krátký název postupu, max 8 slov" },
      kroky: { type: "array", items: { type: "string" }, description: "Kroky v pořadí" },
      upozorneni: { type: "string", description: "Varování nebo poznámka, jinak prázdné" },
    },
    required: ["vyrobce", "nazev", "kroky", "upozorneni"],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return odpoved({ chyba: "Použij POST" }, 405);
  const akce = new URL(req.url).searchParams.get("akce") || "";

  // ověření přihlášeného uživatele
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return odpoved({ chyba: "Chybí přihlášení" }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: u, error: chybaU } = await sb.auth.getUser(token);
  if (chybaU || !u?.user) return odpoved({ chyba: "Neplatné přihlášení" }, 401);

  if (akce !== "rozdel") return odpoved({ chyba: `Neznámá akce „${akce}“` }, 400);

  let vstup: { text?: string; vyrobci?: string[] } = {};
  try { vstup = await req.json(); } catch { return odpoved({ chyba: "Tělo musí být JSON" }, 400); }
  const text = String(vstup.text || "").trim();
  if (!text) return odpoved({ chyba: "Prázdný diktát" }, 400);
  if (text.length > 6000) return odpoved({ chyba: "Diktát je příliš dlouhý" }, 400);
  const vyrobci = (vstup.vyrobci || []).map(String).slice(0, 100);

  const pokyny = `Jsi asistent servisního technika klimatizací (HVAC, VRV, split, tepelná čerpadla).
Z nadiktovaného textu udělej strukturovaný servisní postup v češtině.
- vyrobce: pokud odpovídá některému z existujících (${vyrobci.join(", ") || "žádní"}), použij přesně ten zápis; jiný výrobce normálně; když v textu není, "".
- nazev: krátký název postupu (max 8 slov).
- kroky: jednotlivé kroky v pořadí, každý jedna krátká věta v rozkazovacím způsobu. Zachovej přesně všechna čísla, kódy, tlačítka a přepínače (SW, BS, DIP, C61…). Diktované číslovky převeď na číslice („es vé jedenáct" = SW11). Nic si nevymýšlej a nepřidávej kroky, které v textu nejsou.
- upozorneni: varování nebo poznámka, pokud v textu je, jinak "".`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: "json_schema", json_schema: SCHEMA },
      messages: [{ role: "system", content: pokyny }, { role: "user", content: text }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("OpenAI chyba", r.status, JSON.stringify(data));
    return odpoved({ chyba: `OpenAI ${r.status}: ${data?.error?.message || "chyba"}` }, 502);
  }
  try {
    const z = JSON.parse(data.choices[0].message.content);
    console.log("rozdel ok", u.user.email, z.nazev, (z.kroky || []).length);
    return odpoved(z);
  } catch {
    return odpoved({ chyba: "AI vrátila neplatnou odpověď" }, 502);
  }
});
