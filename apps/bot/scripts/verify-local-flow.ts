import { createHash, randomBytes } from "node:crypto"
import WebSocket from "ws"

function base64Url(buffer: Buffer) {
  return buffer.toString("base64url")
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest()
}

async function run() {
  console.log("=== Step 1: Discover Keycloak & GenioOne Browser Config ===")
  const configRes = await fetch("http://127.0.0.1:5180/v1/identity/browser-configuration")
  if (!configRes.ok) throw new Error(`Browser configuration failed: ${configRes.status}`)
  const config = await configRes.json() as any
  console.log("OpenID Issuer:", config.issuer)
  console.log("Token Endpoint:", config.token_endpoint)

  console.log("\n=== Step 2: PKCE Authorization Flow for local-admin ===")
  const verifierBytes = randomBytes(32)
  const codeVerifier = base64Url(verifierBytes)
  const codeChallenge = base64Url(sha256(Buffer.from(codeVerifier)))
  const state = base64Url(randomBytes(16))
  const redirectUri = "http://127.0.0.1:5180"

  const authUrl = new URL(config.authorization_endpoint)
  authUrl.searchParams.set("client_id", "genio-one-bot")
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("scope", "openid genioone-invocation genioone-management")
  authUrl.searchParams.set("code_challenge", codeChallenge)
  authUrl.searchParams.set("code_challenge_method", "S256")
  authUrl.searchParams.set("state", state)

  // 2a. Request Keycloak login page
  const loginPageRes = await fetch(authUrl, { redirect: "manual" })
  const cookie = loginPageRes.headers.get("set-cookie") || ""
  const html = await loginPageRes.text()

  // Extract form action from Keycloak HTML
  const actionMatch = html.match(/action="([^"]+)"/)
  if (!actionMatch) throw new Error("Could not find login form action in Keycloak page")
  const loginAction = actionMatch[1].replace(/&amp;/g, "&")

  // 2b. Submit credentials (username: local-admin, password: genio-one-local)
  const loginRes = await fetch(loginAction, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: new URLSearchParams({
      username: "admin",
      password: "admin",
    }),
    redirect: "manual",
  })

  const location = loginRes.headers.get("location")
  if (!location) {
    const errText = await loginRes.text()
    throw new Error(`Keycloak login failed without redirect: HTTP ${loginRes.status}\n${errText.slice(0, 300)}`)
  }

  const redirectUrl = new URL(location)
  const authCode = redirectUrl.searchParams.get("code")
  if (!authCode) throw new Error(`Redirect did not contain auth code: ${location}`)
  console.log("Successfully obtained Auth Code via PKCE!")

  // 2c. Exchange code for access_token
  const tokenRes = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "genio-one-bot",
      code: authCode,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  })
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`)
  const tokens = await tokenRes.json() as { access_token: string }
  console.log("Successfully exchanged tokens! Token length:", tokens.access_token.length)

  console.log("\n=== Step 3: Verify GenioOne Platform API Session ===")
  const sessionRes = await fetch("http://127.0.0.1:5180/v1/identity/session", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  if (!sessionRes.ok) throw new Error(`Session verify failed: ${sessionRes.status} ${await sessionRes.text()}`)
  const sessionData = await sessionRes.json()
  console.log("Session verified by Platform API:", JSON.stringify(sessionData, null, 2))

  console.log("\n=== Step 4: Verify GenioOne Catalog ===")
  const catalogRes = await fetch(`http://127.0.0.1:5180/v1/tenants/${encodeURIComponent(sessionData.tenant_id)}/catalog`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  if (!catalogRes.ok) throw new Error(`Catalog fetch failed: ${catalogRes.status} ${await catalogRes.text()}`)
  const catalogData = await catalogRes.json()
  console.log("Catalog capabilities count:", catalogData.capabilities?.length ?? 0)

  console.log("\n=== Step 5: Verify GenioOne Bot WebSocket /api/codex Authentication ===")
  await new Promise<void>((resolvePromise, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:5181/api/codex")
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error("WebSocket authentication timed out"))
    }, 10000)

    ws.on("open", () => {
      console.log("Connected to ws://127.0.0.1:5181/api/codex")
      ws.send(JSON.stringify({
        method: "genio/runtime/start",
        params: { accessToken: tokens.access_token },
      }))
    })

    ws.on("message", (data) => {
      const msg = String(data)
      console.log("Received from Bot /api/codex:", msg)
      const parsed = JSON.parse(msg)
      if (parsed.method === "genio/codexReady") {
        console.log("Codex app-server is READY! Testing initialize and account/read...")
        ws.send(JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "verify-flow", version: "0.1.0" } },
        }))
      }
      if (parsed.id === 1) {
        console.log("Initialize response received:", !!parsed.result)
        ws.send(JSON.stringify({
          id: 2,
          method: "account/read",
          params: { refreshToken: true },
        }))
      }
      if (parsed.id === 2) {
        console.log("account/read response received:", parsed.result)
        if (parsed.result?.account) {
          console.log("Account already logged in!")
          clearTimeout(timeout)
          ws.close()
          resolvePromise()
          return
        }
        console.log("Account not logged in, requesting device code via account/login/start...")
        ws.send(JSON.stringify({
          id: 3,
          method: "account/login/start",
          params: { type: "chatgptDeviceCode" },
        }))
      }
      if (parsed.id === 3) {
        console.log("account/login/start SUCCESS! Verification URL:", parsed.result?.verificationUrl, "User Code:", parsed.result?.userCode)
        clearTimeout(timeout)
        ws.close()
        resolvePromise()
      }
    })

    ws.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })

  console.log("\n=== ALL LOCAL VERIFICATIONS PASSED SUCCESSFULLY! ===")
}

run().catch((err) => {
  console.error("Verification failed:", err)
  process.exit(1)
})
