import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_IMAGE_BASE64_LENGTH = 10_000_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Authorization required" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: creditResult, error: creditError } = await supabase.rpc('deduct_credit', { p_amount: 1, p_reason: 'Nutrition analysis' });
    if (creditError || !creditResult?.success) {
      const errorMsg = creditResult?.error || 'Credit check failed';
      const status = errorMsg.includes('Insufficient') ? 402 : errorMsg.includes('Daily limit') ? 429 : 403;
      return new Response(JSON.stringify({ error: errorMsg }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const MOONSHOT_API_KEY = Deno.env.get("MOONSHOT_API_KEY");
    if (!MOONSHOT_API_KEY) {
      return new Response(JSON.stringify({ error: "Moonshot API key not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { imageBase64 } = body;
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return new Response(JSON.stringify({ error: "imageBase64 is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
      return new Response(JSON.stringify({ error: "Image is too large (max ~7.5MB)" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const dataUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`;

    const resp = await fetch("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MOONSHOT_API_KEY}` },
      body: JSON.stringify({
        model: "kimi-latest",
        temperature: 0.5,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this dish: list ingredients, estimated calories, and give Michelin-style feedback." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("Moonshot API error:", resp.status, errBody);
      return new Response(JSON.stringify({ error: `Moonshot API ${resp.status}: ${errBody.slice(0, 300)}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || "";

    return new Response(JSON.stringify({ text }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("nutrition error:", error);
    return new Response(JSON.stringify({ error: "Nutrition analysis failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
