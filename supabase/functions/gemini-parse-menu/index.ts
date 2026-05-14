import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_TEXT_LENGTH = 50000;

const repairJsonText = (value: string) => value
  .replace(/```json\s*/gi, "")
  .replace(/```/g, "")
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  .trim();

const extractJsonFromResponse = (response: string) => {
  let cleaned = repairJsonText(response);
  const start = cleaned.search(/[\{\[]/);
  if (start === -1) throw new Error("No JSON found in model response");

  const closingChar = cleaned[start] === "[" ? "]" : "}";
  const end = cleaned.lastIndexOf(closingChar);
  if (end === -1 || end <= start) throw new Error("Incomplete JSON returned by model");

  cleaned = cleaned.slice(start, end + 1)
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]");

  return JSON.parse(cleaned);
};

const fallbackParseMenu = (text: string) => {
  const dishes = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [namePart, ...descriptionParts] = line.split(/[:\-–—]/);
      const name = namePart?.trim();
      const description = descriptionParts.join(" - ").trim();
      return name ? { name, description: description || line.trim() } : null;
    })
    .filter((dish): dish is { name: string; description: string } => Boolean(dish?.name));

  return { dishes };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid session" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Atomic credit check & deduction
    const { data: creditResult, error: creditError } = await supabase.rpc('deduct_credit', {
      p_amount: 1,
      p_reason: 'Menu parsing',
    });

    if (creditError || !creditResult?.success) {
      const errorMsg = creditResult?.error || 'Credit check failed';
      const status = errorMsg.includes('Insufficient') ? 402 : errorMsg.includes('Daily limit') ? 429 : 403;
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Gemini API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { text } = body;

    if (!text || typeof text !== "string") {
      return new Response(
        JSON.stringify({ error: "text is required and must be a string" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (text.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "text cannot be empty" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return new Response(
        JSON.stringify({ error: `text must be under ${MAX_TEXT_LENGTH} characters` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{ text: `Parse menu items into structured JSON. Return ONLY a JSON object with a "dishes" array where each item has "name" and "description" string fields. Menu:\n${text}` }],
          }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                dishes: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      name: { type: "STRING" },
                      description: { type: "STRING" },
                    },
                    required: ["name", "description"],
                  },
                },
              },
              required: ["dishes"],
            },
          },
        }),
      }
    );

    if (!geminiResp.ok) {
      const errBody = await geminiResp.text();
      console.error("Gemini API error:", geminiResp.status, errBody);
      return new Response(
        JSON.stringify({ error: `Gemini API ${geminiResp.status}: ${errBody.slice(0, 300)}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiData = await geminiResp.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("\n") || '{"dishes":[]}';
    let parsed: { dishes: Array<{ name: string; description: string }> };
    try {
      const extracted = extractJsonFromResponse(rawText) as { dishes?: Array<{ name?: unknown; description?: unknown }> } | Array<{ name?: unknown; description?: unknown }>;
      const dishes = Array.isArray(extracted) ? extracted : extracted.dishes;
      parsed = {
        dishes: (dishes || [])
          .map((dish) => ({
            name: String(dish.name || "").trim(),
            description: String(dish.description || "").trim(),
          }))
          .filter((dish) => dish.name.length > 0),
      };
    } catch (e) {
      console.error("JSON parse failed. Raw text:", rawText);
      parsed = fallbackParseMenu(text);
    }

    if (!parsed.dishes.length) {
      parsed = fallbackParseMenu(text);
    }

    if (!parsed.dishes.length) {
      return new Response(
        JSON.stringify({ error: "No menu items found. Use one item per line, for example: Dish name: description." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify(parsed),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("gemini-parse-menu error:", error);
    return new Response(
      JSON.stringify({ error: "Menu parsing failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
