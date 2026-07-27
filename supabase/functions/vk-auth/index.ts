import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const VK_APP_ID = '54614369'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { access_token, redirectTo } = await req.json()
    if (!access_token) {
      return new Response(JSON.stringify({ error: 'Missing access_token' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    // Get user info from VK ID
    const userResp = await fetch('https://id.vk.com/oauth2/user_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${VK_APP_ID}&access_token=${encodeURIComponent(access_token)}`,
    })
    const userText = await userResp.text()
    console.log('VK user_info:', userText.slice(0, 500))

    let userData: Record<string, unknown>
    try { userData = JSON.parse(userText) }
    catch { return new Response(JSON.stringify({ error: 'VK user_info non-JSON: ' + userText.slice(0, 200) }), {
      status: 502, headers: { ...CORS, 'Content-Type': 'application/json' }
    })}

    let vkUser = (userData.user || {}) as Record<string, string>
    if (!vkUser.user_id) {
      const apiResp = await fetch(
        `https://api.vk.com/method/users.get?fields=photo_200,email&access_token=${access_token}&v=5.131`
      )
      const apiJson = await apiResp.json()
      const u = apiJson.response?.[0] || {}
      vkUser = { user_id: String(u.id), first_name: u.first_name, last_name: u.last_name, avatar: u.photo_200 }
      console.log('VK api fallback:', JSON.stringify(vkUser))
    }

    const user_id = vkUser.user_id
    if (!user_id || user_id === 'undefined') {
      return new Response(JSON.stringify({ error: 'No user_id: ' + userText.slice(0, 300) }), {
        status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    const displayName = [vkUser.first_name, vkUser.last_name].filter(Boolean).join(' ') || `VK${user_id}`
    const avatarUrl   = vkUser.avatar || null
    // Синтетический email — реально не отправляется, нужен только как ключ
    // идентификации в auth.users (email_confirm: true, письма никто не ждёт).
    const email       = `vk${user_id}@fantasysta.app`

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: { users }, error: listErr } = await sb.auth.admin.listUsers({ perPage: 1000 })
    if (listErr) throw listErr

    let targetUser = users?.find(u => u.user_metadata?.vk_id === String(user_id))

    if (targetUser) {
      await sb.auth.admin.updateUserById(targetUser.id, {
        user_metadata: { ...targetUser.user_metadata, vk_id: String(user_id), full_name: displayName, avatar_url: avatarUrl }
      })
    } else {
      const { data: created, error: createErr } = await sb.auth.admin.createUser({
        email, email_confirm: true,
        user_metadata: { vk_id: String(user_id), full_name: displayName, avatar_url: avatarUrl, provider: 'vk' },
      })
      if (createErr) {
        targetUser = users?.find(u => u.email === email)
        if (!targetUser) throw createErr
      } else {
        targetUser = created.user!
      }
    }

    const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
      type: 'magiclink',
      email: targetUser!.email!,
      options: { redirectTo: redirectTo || 'https://fantasysta-app.vercel.app/' }
    })
    if (linkErr) throw linkErr

    return new Response(JSON.stringify({
      token_hash: linkData.properties.hashed_token,
      email: targetUser!.email,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (e) {
    console.error('vk-auth error:', e)
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})
