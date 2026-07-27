import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabaseClient.js";

export const VK_APP_ID = "54614369";

function vkRedirectUri() {
  return window.location.origin + window.location.pathname;
}

async function vkPkce() {
  const arr = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return { verifier, challenge };
}

// Редиректит на id.vk.ru — без SDK, вручную (тот же приём, что в Brain Fight Club:
// не зависит от того, доходят ли письма и открывается ли *.supabase.co без VPN).
export async function signInWithVK() {
  const { verifier, challenge } = await vkPkce();
  const device_id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  sessionStorage.setItem("vk_code_verifier", verifier);
  sessionStorage.setItem("vk_device_id", device_id);

  const authUrl = "https://id.vk.ru/authorize?" + new URLSearchParams({
    response_type: "code",
    client_id: VK_APP_ID,
    redirect_uri: vkRedirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    device_id,
    scope: "vkid.personal_info email",
    state: crypto.randomUUID(),
  });
  window.location.href = authUrl;
}

// Вызывать один раз при старте приложения. Если в адресе есть code от VK —
// меняет его на VK access_token, зовёт Edge Function vk-auth (она сама
// создаёт/находит пользователя в auth.users и отдаёт token_hash), и завершает
// вход через verifyOtp — без единого реального письма.
export async function handleVKCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const type = params.get("type");
  const device_id = params.get("device_id") || "";
  if (!code || type !== "code_v2") return { handled: false, error: null };

  window.history.replaceState({}, "", window.location.pathname);

  try {
    const verifier = sessionStorage.getItem("vk_code_verifier") || "";
    sessionStorage.removeItem("vk_code_verifier");

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      device_id: device_id || sessionStorage.getItem("vk_device_id") || "",
      redirect_uri: vkRedirectUri(),
      client_id: VK_APP_ID,
      code_verifier: verifier,
    });
    const tokenResp = await fetch("https://id.vk.ru/oauth2/auth", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenData = await tokenResp.json();
    const access_token = tokenData.access_token;
    if (!access_token) throw new Error("VK token error: " + JSON.stringify(tokenData).slice(0, 200));

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/vk-auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // До входа нет пользовательской сессии — шлюз Supabase Functions всё
        // равно требует Authorization с валидным JWT, подходит и публичный anon-ключ.
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ access_token, redirectTo: vkRedirectUri() }),
    });
    const result = await resp.json();
    if (result.error || result.message) throw new Error(result.error || result.message);
    if (!result.token_hash) throw new Error("Пустой ответ от vk-auth: " + JSON.stringify(result).slice(0, 200));

    const { error: verifyErr } = await supabase.auth.verifyOtp({ token_hash: result.token_hash, type: "email" });
    if (verifyErr) throw verifyErr;

    return { handled: true, error: null };
  } catch (e) {
    return { handled: true, error: e?.message || String(e) };
  }
}
