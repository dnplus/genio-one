import type { BotSidebarSummary } from "../shared/bot-roster"
import { useCallback, useEffect, useState } from "react"
import { LoaderCircle } from "lucide-react"

import {
  clearBotLocalCache,
  readActiveBotId,
  readBots,
  readLegacyLocalBots,
  readUnreadBotIds,
  saveActiveBotId,
  saveBots,
  saveUnreadBotIds,
  type BotBinding,
  type BotInstance,
} from "./bots-storage"
import {
  clearGenioTokens,
  completeGenioLogin,
  isJwtExpired,
  loadGenioContext,
  refreshGenioLogin,
  type GenioCatalog,
  type GenioIdentity,
} from "./lib/genio-one"
import {
  assertDesignerReadBack,
  designerCreatePayload,
  type BotDesignerDraft,
} from "../server/bot-designer"
import {
  createBot as createBotOnServer,
  addBotBinding,
  deleteBot as deleteBotOnServer,
  duplicateBot as duplicateBotOnServer,
  getBotProfile,
  getCeDemoTask,
  installBotPackage,
  listBotPackages,
  type BotProfileDto,
  listBotRoster,
  listBots as listBotsOnServer,
  requestBotPackageAccess,
  removeBotBindings,
  updateBot as updateBotOnServer,
  type BotPackageManifest,
  type BotWorkState,
  type CeDemoTaskDto,
} from "./lib/bot-api"
import { replaceResourceBindings } from "./lib/catalog-surface"
import { botCopy } from "./lib/ui-copy"

import {
  demoCatalog,
  demoIdentity,
  SignIn,
  Onboarding,
  Workspace,
  CeDemoTask,
  CreateBotModal,
  CorpBotCatalogModal,
} from "./components"
import { CE_DEMO_PROMPTS, type CeDemoPromptId } from "@genioone/protocol/ce-demo"

let pendingGenioLogin: Promise<string> | null = null

function completeGenioLoginOnce(): Promise<string> {
  if (!pendingGenioLogin) {
    pendingGenioLogin = completeGenioLogin().finally(() => {
      pendingGenioLogin = null
    })
  }
  return pendingGenioLogin
}

function readCeDemoPromptId(): CeDemoPromptId | null {
  const value = new URLSearchParams(location.search).get("demo")
  return CE_DEMO_PROMPTS.some((prompt) => prompt.id === value) ? value as CeDemoPromptId : null
}

export function App() {
  const demo = new URLSearchParams(location.search).get("demo") === "1"
  const ceDemoPromptId = readCeDemoPromptId()
  const [loading, setLoading] = useState(!demo)
  const [botLoadError, setBotLoadError] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [token, setToken] = useState(demo ? "demo" : "")
  const [identity, setIdentity] = useState<GenioIdentity | null>(demo ? demoIdentity() : null)
  const [catalog, setCatalog] = useState<GenioCatalog | null>(() => (demo ? demoCatalog() : null))
  // Production roster SoT is server registry; localStorage only for ?demo=1 fallback.
  const [bots, setBots] = useState<BotInstance[]>(() => (demo ? readBots(true) : []))
  const [activeBotId, setActiveBotId] = useState<string | null>(() => {
    if (!demo) return null
    const saved = readActiveBotId()
    const currentBots = readBots(true)
    if (saved && currentBots.some((b) => b.id === saved)) return saved
    return currentBots[0]?.id ?? null
  })
  // Production unread/working come from server BotSession projection; localStorage only for ?demo=1.
  const [unreadBotIds, setUnreadBotIds] = useState<Set<string>>(() => {
    if (!demo) return new Set()
    const saved = readUnreadBotIds()
    if (saved.length > 0) return new Set(saved)
    return new Set(["bot-nova"])
  })
  const [summaries, setSummaries] = useState<Record<string, BotSidebarSummary>>({})
  const [workStates, setWorkStates] = useState<Record<string, BotWorkState>>({})
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [corpCatalogOpen, setCorpCatalogOpen] = useState(false)
  const [corpPackages, setCorpPackages] = useState<BotPackageManifest[]>([])
  const [corpCatalogMessage, setCorpCatalogMessage] = useState("")
  const [ceDemoTask, setCeDemoTask] = useState<CeDemoTaskDto | null>(null)
  const [ceDemoPrompt, setCeDemoPrompt] = useState(() => CE_DEMO_PROMPTS.find((prompt) => prompt.id === ceDemoPromptId)?.text ?? "")
  const [ceDemoLoading, setCeDemoLoading] = useState(Boolean(ceDemoPromptId))
  const [ceDemoInstalling, setCeDemoInstalling] = useState(false)
  const [ceDemoError, setCeDemoError] = useState("")
  const [ceDemoStarted, setCeDemoStarted] = useState(false)
  const [ceDemoAttempt, setCeDemoAttempt] = useState(0)

  const handleSignOut = useCallback(() => {
    clearGenioTokens()
    sessionStorage.removeItem("genio.bot.thread_id")
    setToken("")
    setIdentity(null)
    setCatalog(null)
  }, [])

  useEffect(() => {
    if (demo) return
    void (async () => {
      let accessToken = await completeGenioLoginOnce()
      if (!accessToken) return
      let context
      try {
        context = await loadGenioContext(accessToken)
      } catch {
        accessToken = await refreshGenioLogin()
        if (!accessToken) {
          handleSignOut()
          return
        }
        try {
          context = await loadGenioContext(accessToken)
        } catch {
          handleSignOut()
          return
        }
      }
      setToken(accessToken)
      setIdentity(context.identity)
      setCatalog(context.catalog)
      try {
        const serverBots = await listBotsOnServer(accessToken)
        let effectiveBots = serverBots
        const legacyBots = readLegacyLocalBots(false)
        if (serverBots.length === 0 && legacyBots.length > 0) {
          const migrated: BotInstance[] = []
          for (const legacy of legacyBots) {
            try {
              migrated.push(await createBotOnServer(accessToken, {
                name: legacy.name,
                title: legacy.title || legacy.role,
                description: legacy.description || legacy.role,
                avatar: legacy.avatar,
                skills: legacy.skills,
                modelRoute: legacy.modelRoute,
                defaultRuntimeTier: legacy.defaultRuntimeTier,
              }))
              clearBotLocalCache(legacy.id)
            } catch (err) {
              console.warn("Failed to migrate legacy bot to server:", legacy.name, err)
            }
          }
          if (migrated.length > 0) {
            effectiveBots = migrated
            localStorage.removeItem("genio.bots.list")
            localStorage.removeItem("genio.bot.profile")
          }
        }
        setBots(effectiveBots)
        try {
          const roster = await listBotRoster(accessToken)
          const unread = new Set<string>()
          const working: Record<string, BotWorkState> = {}
          for (const entry of roster) {
            working[entry.bot.id] = entry.session.workState
            if (entry.session.unread) unread.add(entry.bot.id)
          }
          setUnreadBotIds(unread)
          setWorkStates(working)
          setSummaries(Object.fromEntries(roster.map((entry) => [entry.bot.id, entry.summary])))
        } catch (rosterError) {
          console.warn("Bot roster projection unavailable", rosterError)
        }
        const selected = readActiveBotId()
        if (selected && effectiveBots.some((bot) => bot.id === selected)) setActiveBotId(selected)
        else if (effectiveBots[0]) {
          setActiveBotId(effectiveBots[0].id)
          saveActiveBotId(effectiveBots[0].id)
        }
      } catch (error) {
        setBotLoadError(true)
        console.warn("Bot registry unavailable", error)
      }
    })().finally(() => setLoading(false))
  }, [demo, loadAttempt])

  useEffect(() => {
    if (demo || !token) return
    const checkExpiry = async () => {
      if (isJwtExpired(token, 15)) {
        try {
          const refreshed = await refreshGenioLogin()
          if (!refreshed) {
            handleSignOut()
            return
          }
          const context = await loadGenioContext(refreshed)
          setToken(refreshed)
          setIdentity(context.identity)
          setCatalog(context.catalog)
        } catch {
          handleSignOut()
        }
      }
    }
    const interval = setInterval(() => void checkExpiry(), 10_000)
    return () => clearInterval(interval)
  }, [demo, token])

  useEffect(() => {
    if (!ceDemoPromptId || !token) return
    let cancelled = false
    setCeDemoLoading(true)
    setCeDemoError("")
    void getCeDemoTask(token, ceDemoPromptId).then((task) => {
      if (!cancelled) setCeDemoTask(task)
    }).catch((error) => {
      if (!cancelled) setCeDemoError(error instanceof Error ? error.message : "CE_DEMO_UNAVAILABLE")
    }).finally(() => {
      if (!cancelled) setCeDemoLoading(false)
    })
    return () => { cancelled = true }
  }, [ceDemoPromptId, token, ceDemoAttempt])

  const refreshRosterProjection = useCallback(async (accessToken: string) => {
    const roster = await listBotRoster(accessToken)
    const unread = new Set<string>()
    const working: Record<string, BotWorkState> = {}
    for (const entry of roster) {
      working[entry.bot.id] = entry.session.workState
      if (entry.session.unread) unread.add(entry.bot.id)
    }
    setUnreadBotIds(unread)
    setWorkStates(working)
    setSummaries(Object.fromEntries(roster.map((entry) => [entry.bot.id, entry.summary])))
    return roster
  }, [])

  useEffect(() => {
    if (demo || !token) return
    const tick = () => {
      void refreshRosterProjection(token).catch((error) => console.warn("Roster projection poll failed", error))
    }
    const interval = setInterval(tick, 8_000)
    return () => clearInterval(interval)
  }, [demo, token, refreshRosterProjection])

  const hydrateFromLive = (created: BotInstance, live: BotProfileDto): BotInstance => ({
    ...created,
    name: live.name,
    title: live.title,
    description: live.description,
    antiJobs: live.antiJobs,
    voice: live.voice,
    wake: live.wake,
    role: live.description,
    avatar: (live.avatar as BotInstance["avatar"]) ?? created.avatar,
    modelRoute: live.modelRoute,
    tenantId: live.tenantId,
    ownerSubjectId: live.ownerSubjectId,
    createdAt: live.createdAt,
    updatedAt: live.updatedAt,
    skills: created.skills ?? [],
    sharePolicy: created.sharePolicy ?? {
      visibility: live.visibility || "PRIVATE",
      discoverable: false,
      invocable: false,
      approval: "ALWAYS_ASK",
      audienceIds: [],
    },
  })

  const createAndVerifyDesigner = async (draft: BotDesignerDraft) => {
    const payload = designerCreatePayload(draft)
    if (demo) {
      const id = `bot-${crypto.randomUUID().slice(0, 8)}`
      const live: BotProfileDto = {
        botId: id,
        name: payload.name,
        title: payload.title,
        description: payload.description,
        antiJobs: payload.antiJobs,
        voice: payload.voice,
        wake: payload.wake,
        visibility: "PRIVATE",
        avatar: payload.avatar,
        modelRoute: payload.modelRoute,
        tenantId: identity?.tenant_id || "tenant-demo",
        ownerSubjectId: identity?.subject_id || "demo-user",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      assertDesignerReadBack(draft, live)
      const bot: BotInstance = {
        id,
        name: live.name,
        title: live.title,
        description: live.description,
        antiJobs: live.antiJobs,
        voice: live.voice,
        wake: live.wake,
        role: live.description,
        avatar: (live.avatar as BotInstance["avatar"]),
        workspacePath: `/workspaces/${id}`,
        skills: [],
        sharePolicy: { visibility: "PRIVATE", discoverable: false, invocable: false, approval: "ALWAYS_ASK", audienceIds: [] },
        createdAt: live.createdAt,
        updatedAt: live.updatedAt,
        tenantId: live.tenantId,
        ownerSubjectId: live.ownerSubjectId,
        modelRoute: live.modelRoute,
      }
      return { draft, live, bot }
    }
    const created = await createBotOnServer(token, payload)
    const live = await getBotProfile(token, created.id)
    assertDesignerReadBack(draft, live)
    if ((created.skills?.length ?? 0) > 0) throw new Error("DESIGNER_MUST_NOT_INSTALL_SKILLS")
    if ((created.bindings?.length ?? 0) > 0) throw new Error("DESIGNER_MUST_NOT_INSTALL_BINDINGS")
    if (live.visibility !== "PRIVATE") throw new Error("DESIGNER_MUST_BE_PRIVATE")
    return { draft, live, bot: hydrateFromLive(created, live) }
  }

  const activateBot = (bot: BotInstance) => {
    setBots((current) => {
      const next = current.some((item) => item.id === bot.id) ? current : [...current, bot]
      if (demo) saveBots(next)
      return next
    })
    setActiveBotId(bot.id)
    saveActiveBotId(bot.id)
    setCreateModalOpen(false)
  }

  const handleToggleBinding = useCallback(async (
    botId: string,
    resourceId: string,
    capabilityId: string,
    currentlyInstalled: boolean,
  ) => {
    const currentBot = bots.find((bot) => bot.id === botId)
    if (!currentBot) throw new Error("BOT_NOT_FOUND")
    if (demo) {
      const nextBinding: BotBinding | null = currentlyInstalled ? null : {
        resourceId,
        capabilityId,
        version: "1.0.0",
        state: "INSTALLED",
        kind: "MCP",
      }
      const updated = {
        ...currentBot,
        bindings: replaceResourceBindings(currentBot.bindings ?? [], resourceId, nextBinding),
      }
      const next = bots.map((bot) => bot.id === botId ? updated : bot)
      setBots(next)
      saveBots(next)
      return
    }
    if (!token) throw new Error("BOT_AUTH_REQUIRED")
    if (currentlyInstalled) {
      await removeBotBindings(token, botId, resourceId)
    } else {
      await addBotBinding(token, botId, { resourceId, capabilityId, kind: "MCP" })
    }
    const roster = await refreshRosterProjection(token)
    const authoritative = roster.find((entry) => entry.bot.id === botId)?.bot
    if (!authoritative) throw new Error("BOT_BINDING_READBACK_FAILED")
    setBots((current) => current.map((bot) => bot.id === botId ? authoritative : bot))
  }, [bots, demo, refreshRosterProjection, token])

  const handleUpdateBot = (updated: BotInstance) => {
    if (!demo) {
      void updateBotOnServer(token, updated.id, {
        name: updated.name,
        title: updated.title,
        description: updated.description,
        avatar: updated.avatar,
        skills: updated.skills,
        allowedTools: updated.allowedTools,
        defaultRuntimeTier: updated.defaultRuntimeTier,
        modelRoute: updated.modelRoute,
        sharePolicy: updated.sharePolicy,
      }).then((saved) => setBots((current) => current.map((bot) => bot.id === saved.id ? saved : bot))).catch((error) => console.warn("Update Bot failed", error))
      return
    }
    const next = bots.map((b) => b.id === updated.id ? updated : b)
    setBots(next)
    saveBots(next)
  }

  const handleDuplicateBot = (source: BotInstance) => {
    if (demo) {
      const copy: BotInstance = { ...source, id: `bot-${crypto.randomUUID().slice(0, 8)}`, name: `${source.name} 副本`, createdAt: Date.now(), updatedAt: Date.now() }
      const next = [...bots, copy]
      setBots(next)
      saveBots(next)
      setActiveBotId(copy.id)
      saveActiveBotId(copy.id)
      return
    }
    void duplicateBotOnServer(token, source.id).then((copy) => {
      setBots((current) => [...current, copy])
      setActiveBotId(copy.id)
      saveActiveBotId(copy.id)
    }).catch((error) => console.warn("Duplicate Bot failed", error))
  }

  const handleDeleteBot = async (target: BotInstance) => {
    if (!demo && token) {
      try {
        await deleteBotOnServer(token, target.id)
      } catch (error) {
        console.warn("Delete Bot failed", error)
      }
    }
    const next = bots.filter((b) => b.id !== target.id)
    setBots(next)
    if (demo) {
      saveBots(next)
    }
    if (activeBotId === target.id) {
      const nextActive = next[0]
      if (nextActive) {
        setActiveBotId(nextActive.id)
        saveActiveBotId(nextActive.id)
      }
    }
  }

  const handleOpenCorpCatalog = () => {
    setCorpCatalogMessage("")
    if (demo) {
      setCorpPackages([])
      setCorpCatalogOpen(true)
      return
    }
    void listBotPackages(token).then((packages) => {
      setCorpPackages(packages)
      setCorpCatalogOpen(true)
    }).catch((error) => console.warn("Corp Bot catalog failed", error))
  }

  const handleInstallCorpBot = (packageInfo: BotPackageManifest) => {
    if (packageInfo.accessStatus === "REQUEST") {
      if (!identity) return
      void requestBotPackageAccess(token, identity.tenant_id, packageInfo)
        .then(() => setCorpCatalogMessage("已送出權限申請；Owner 核准後即可再次 Add。"))
        .catch((error) => setCorpCatalogMessage(error instanceof Error ? error.message : "權限申請失敗"))
      return
    }
    if (packageInfo.connectionStatus === "NEEDS_CONNECTION") {
      setCorpCatalogMessage("此 Bot 需要先完成企業 Connection/OAuth 連線。")
      return
    }
    if (demo) {
      const installed: BotInstance = {
        id: `bot-${crypto.randomUUID().slice(0, 8)}`,
        name: packageInfo.profile.title,
        title: packageInfo.profile.title,
        description: packageInfo.profile.description,
        role: packageInfo.profile.description,
        avatar: packageInfo.profile.avatar as BotInstance["avatar"],
        workspacePath: `/workspaces/corp-service-desk-${Date.now()}`,
        skills: packageInfo.skills.map((skill) => skill.id),
        defaultRuntimeTier: packageInfo.defaultRuntimeTier,
        sourceResourceId: packageInfo.resourceId,
        sourceVersion: packageInfo.version,
        sourceDigest: packageInfo.artifactDigest,
        bindings: [
          ...packageInfo.skills.map((skill) => ({ resourceId: packageInfo.resourceId, capabilityId: `skill.${skill.id}`, version: packageInfo.version, artifactDigest: packageInfo.artifactDigest, state: "INSTALLED" as const, kind: "SKILL" as const })),
          ...packageInfo.plugins.map((plugin) => ({ resourceId: packageInfo.resourceId, capabilityId: `plugin.${plugin.name}`, version: packageInfo.version, artifactDigest: packageInfo.artifactDigest, state: "INSTALLED" as const, kind: "PLUGIN" as const })),
          ...packageInfo.resourceBindings.map((binding) => ({ resourceId: binding.resourceId, capabilityId: binding.capabilityId, version: packageInfo.version, artifactDigest: packageInfo.artifactDigest, state: "INSTALLED" as const, kind: "MCP" as const })),
        ],
        sharePolicy: { visibility: "PRIVATE", discoverable: false, invocable: false, approval: "ALWAYS_ASK", audienceIds: [] },
        createdAt: Date.now(),
      }
      const next = [...bots, installed]
      setBots(next)
      saveBots(next)
      setActiveBotId(installed.id)
      saveActiveBotId(installed.id)
      setCorpCatalogOpen(false)
      return
    }
    void installBotPackage(token, packageInfo.resourceId, packageInfo.version).then((installed) => {
      setBots((current) => current.some((bot) => bot.id === installed.id) ? current : [...current, installed])
      setActiveBotId(installed.id)
      saveActiveBotId(installed.id)
      setCorpCatalogOpen(false)
    }).catch((error) => console.warn("Install Corp Bot failed", error))
  }

  const handleMarkBotUnread = useCallback((id: string) => {
    if (demo) {
      setUnreadBotIds((prev) => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        saveUnreadBotIds(Array.from(next))
        return next
      })
      return
    }
    if (!token || !id) return
    void refreshRosterProjection(token).catch((error) => console.warn("Roster refresh failed", error))
  }, [demo, token, refreshRosterProjection])

  const handleBotWorkEvent = useCallback((id: string, _type: "turn_started" | "turn_stopped" | "turn_idle") => {
    if (demo || !token || !id) return
    void refreshRosterProjection(token).catch((error) => console.warn("Roster refresh failed", error))
  }, [demo, token, refreshRosterProjection])

  const handleSelectBot = (id: string) => {
    if (demo) {
      setUnreadBotIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        saveUnreadBotIds(Array.from(next))
        return next
      })
    }
    setActiveBotId(id)
    saveActiveBotId(id)
  }

  const handleBotViewed = useCallback((_id: string) => {
    if (!demo && token) void refreshRosterProjection(token).catch((error) => console.warn("Roster refresh failed", error))
  }, [demo, token, refreshRosterProjection])

  const findCeDemoBot = () => ceDemoTask
    ? bots.find((bot) => bot.sourceResourceId === ceDemoTask.resourceId && bot.sourceVersion === ceDemoTask.manifest.version)
    : undefined

  const startCeDemo = () => {
    const installed = findCeDemoBot()
    if (!installed) {
      setCeDemoError(botCopy("Install my demo Bot first.", "請先安裝我的示範 Bot。"))
      return
    }
    setActiveBotId(installed.id)
    saveActiveBotId(installed.id)
    setCeDemoStarted(true)
  }

  const installCeDemo = () => {
    if (!ceDemoTask || !token) return
    setCeDemoInstalling(true)
    setCeDemoError("")
    void installBotPackage(token, ceDemoTask.resourceId, ceDemoTask.manifest.version, ceDemoTask.useCaseId).then((installed) => {
      setBots((current) => current.some((bot) => bot.id === installed.id) ? current : [...current, installed])
      setActiveBotId(installed.id)
      saveActiveBotId(installed.id)
      setCeDemoStarted(true)
    }).catch((error) => setCeDemoError(error instanceof Error ? error.message : "BOT_INSTALL_FAILED"))
      .finally(() => setCeDemoInstalling(false))
  }

  const retryCeDemo = () => {
    setCeDemoTask(null)
    setCeDemoError("")
    setCeDemoAttempt((attempt) => attempt + 1)
  }

  const returnToMyBots = () => {
    const url = new URL(location.href)
    url.searchParams.delete("demo")
    location.assign(url.toString())
  }

  if (loading) return <main className="loading-screen"><LoaderCircle className="spin" />{botCopy("Connecting to GenioOne", "正在連接 GenioOne")}</main>
  if (!identity) return <SignIn />
  if (botLoadError) return <main className="loading-screen"><p role="alert">{botCopy("The Bot roster is temporarily unavailable. Existing Bots and conversations are preserved.", "Bot 清單暫時無法載入，既有 Bot 與對話記錄仍保留。")}</p><button type="button" onClick={() => { setBotLoadError(false); setLoading(true); setLoadAttempt((attempt) => attempt + 1) }}>{botCopy("Reload Bot roster", "重新載入 Bot 清單")}</button></main>
  if (ceDemoPromptId && !ceDemoStarted) {
    return <CeDemoTask task={ceDemoTask} prompt={ceDemoPrompt} loading={ceDemoLoading} installing={ceDemoInstalling} error={ceDemoError} onPromptChange={setCeDemoPrompt} onInstall={installCeDemo} onStart={startCeDemo} onRetry={retryCeDemo} onReturnToBots={returnToMyBots} />
  }
  if (bots.length === 0) {
    return (
      <Onboarding
        identity={identity}
        createAndVerify={createAndVerifyDesigner}
        onReady={(bot) => {
          setBots([bot])
          if (demo) saveBots([bot])
          setActiveBotId(bot.id)
          saveActiveBotId(bot.id)
        }}
        onSignOut={handleSignOut}
      />
    )
  }

  const activeBot = bots.find((b) => b.id === activeBotId) || bots[0]!

  return (
    <>
      <Workspace
        bots={bots}
        activeBot={activeBot}
        onSelectBot={handleSelectBot}
        onAddBot={() => setCreateModalOpen(true)}
        onUpdateBot={handleUpdateBot}
        onToggleBinding={handleToggleBinding}
        onDuplicateBot={handleDuplicateBot}
        onDeleteBot={handleDeleteBot}
        onOpenCorpCatalog={handleOpenCorpCatalog}
        token={token}
        demo={demo}
        catalog={catalog}
        identity={identity}
        unreadBotIds={unreadBotIds}
        workStates={workStates}
        summaries={demo ? undefined : summaries}
        onMarkBotUnread={handleMarkBotUnread}
        onBotWorkEvent={handleBotWorkEvent}
        onBotViewed={handleBotViewed}
        onSignOut={handleSignOut}
        initialInput={ceDemoPromptId && ceDemoStarted ? { key: `${ceDemoPromptId}:${activeBot.id}`, text: ceDemoPrompt } : undefined}
      />
      {createModalOpen && (
        <CreateBotModal
          onClose={() => setCreateModalOpen(false)}
          createAndVerify={createAndVerifyDesigner}
          onReady={activateBot}
        />
      )}
      {corpCatalogOpen && (
        <CorpBotCatalogModal
          packages={corpPackages}
          message={corpCatalogMessage}
          onClose={() => setCorpCatalogOpen(false)}
          onInstall={handleInstallCorpBot}
        />
      )}
    </>
  )
}
