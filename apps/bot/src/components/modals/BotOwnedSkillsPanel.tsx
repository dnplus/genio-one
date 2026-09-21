import { FileCode2, FilePlus2, History, LoaderCircle, Plus, RefreshCw, Save } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  BotDefaultToolError,
  listOwnedSkills,
  readOwnedSkill,
  revertOwnedSkill,
  type OwnedSkill,
  type OwnedSkillRevision,
  writeOwnedSkill,
} from "../../lib/bot-default-tools-api"
import { beginGenioLogin } from "../../lib/genio-one"
import { botCopy } from "../../lib/ui-copy"
import "./BotOwnedSkillsPanel.css"

export function defaultDescriptor(skillName: string, description: string) {
  return `---\nname: ${JSON.stringify(skillName)}\ndescription: ${JSON.stringify(description || "Describe what this Bot-specific skill does.")}\n---\n\n# ${skillName}\n\n`
}

function skillNameError(value: string) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? null : "OWNED_SKILL_NAME_INVALID"
}

function userMessage(error: unknown) {
  const code = error instanceof BotDefaultToolError ? error.code : error instanceof Error ? error.message : ""
  if (/AUTH|TOKEN|UNAUTHORIZED|SIGN_IN|SESSION/i.test(code)) return botCopy("Your sign-in has expired. Sign in again, then retry.", "登入已過期，請重新登入後再試。")
  if (/REVISION_CONFLICT|CONFLICT/i.test(code)) return botCopy("This Skill changed elsewhere. Refresh it, review the saved version, then apply your edits again.", "此 Skill 已在其他地方更新。請重新載入、確認儲存版本後，再套用你的修改。")
  if (/NAME_INVALID/i.test(code)) return botCopy("Use lowercase letters, numbers, and hyphens for the Skill name.", "Skill 名稱請使用小寫英文字母、數字及連字號。")
  if (/FRONTMATTER/i.test(code)) return botCopy("SKILL.md needs name and description frontmatter that matches the Skill name.", "SKILL.md 必須有與 Skill 名稱相符的 name 及 description frontmatter。")
  return botCopy("The Skill could not be saved. Your edits are still here; try again shortly.", "Skill 尚未儲存。你的修改已保留，請稍後再試。")
}

function needsSignIn(error: unknown) {
  const code = error instanceof BotDefaultToolError ? error.code : error instanceof Error ? error.message : ""
  return /AUTH|TOKEN|UNAUTHORIZED|SIGN_IN|SESSION/i.test(code)
}

function isRevisionConflict(error: unknown) {
  const code = error instanceof BotDefaultToolError ? error.code : error instanceof Error ? error.message : ""
  return /REVISION_CONFLICT|CONFLICT/i.test(code)
}

function isNotFound(error: unknown) {
  const code = error instanceof BotDefaultToolError ? error.code : error instanceof Error ? error.message : ""
  return /NOT_FOUND/i.test(code)
}

function filesAsRecord(skill: OwnedSkill) {
  return Object.fromEntries(skill.files.map((file) => [file.path, file.content]))
}

function humanUpdatedAt(value: number | undefined) {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}

export function BotOwnedSkillsPanel({ botId, accessToken, disabled = false, onDirtyChange, onBusyChange }: { botId: string; accessToken?: string; disabled?: boolean; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const [skills, setSkills] = useState<Array<{ skillName: string; revision: number; updatedAt: number }>>([])
  const [selectedName, setSelectedName] = useState("")
  const [loadedSkill, setLoadedSkill] = useState<OwnedSkill | null>(null)
  const [revisions, setRevisions] = useState<OwnedSkillRevision[]>([])
  const [selectedPath, setSelectedPath] = useState("SKILL.md")
  const [files, setFiles] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [newPath, setNewPath] = useState("")
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [signInRequired, setSignInRequired] = useState(() => !accessToken)
  const [needsReload, setNeedsReload] = useState(false)
  const readAbortRef = useRef<AbortController | null>(null)

  const signedIn = Boolean(accessToken)
  const busy = disabled || reading || saving
  const dirty = useMemo(() => loadedSkill !== null && (loadedSkill.revision === 0 || loadedSkill.deleted === true || JSON.stringify(files) !== JSON.stringify(filesAsRecord(loadedSkill))), [files, loadedSkill])

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  const loadList = useCallback(async (signal?: AbortSignal) => {
    if (!accessToken) return
    setLoading(true)
    setError("")
    try {
      const value = await listOwnedSkills(accessToken, botId, signal)
      if (signal?.aborted) return
      setSkills(value.skills)
      setSignInRequired(false)
    } catch (cause) {
      if (!signal?.aborted) {
        setError(userMessage(cause))
        setSignInRequired(needsSignIn(cause))
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [accessToken, botId])

  const read = useCallback(async (skillName: string, signal?: AbortSignal, clearMessage = true) => {
    if (!accessToken) return
    setReading(true)
    setError("")
    try {
      const value = await readOwnedSkill(accessToken, botId, skillName, signal)
      if (signal?.aborted) return
      setSelectedName(value.skill.skillName)
      setLoadedSkill(value.skill)
      setFiles(filesAsRecord(value.skill))
      setSelectedPath(value.skill.files.some((file) => file.path === "SKILL.md") ? "SKILL.md" : value.skill.files[0]?.path ?? "SKILL.md")
      setRevisions(value.revisions ?? [])
      if (clearMessage) setMessage("")
    } catch (cause) {
      if (!signal?.aborted) {
        setError(userMessage(cause))
        setSignInRequired(needsSignIn(cause))
      }
    } finally {
      if (!signal?.aborted) setReading(false)
    }
  }, [accessToken, botId])

  useEffect(() => {
    const controller = new AbortController()
    void loadList(controller.signal)
    return () => controller.abort()
  }, [loadList])

  useEffect(() => () => readAbortRef.current?.abort(), [])

  const chooseSkill = (skillName: string) => {
    if (busy) return
    if (dirty && !window.confirm(botCopy("Discard unsaved Skill edits?", "要放棄尚未儲存的 Skill 修改嗎？"))) return
    readAbortRef.current?.abort()
    const controller = new AbortController()
    readAbortRef.current = controller
    void read(skillName, controller.signal)
  }

  const reloadCurrentSkill = () => {
    if (busy) return
    if (!selectedName) return
    if (dirty && !window.confirm(botCopy("Reload the saved Skill and discard the edits currently on screen?", "要重新載入已儲存的 Skill，並放棄目前畫面上的修改嗎？"))) return
    readAbortRef.current?.abort()
    const controller = new AbortController()
    readAbortRef.current = controller
    setNeedsReload(false)
    void read(selectedName, controller.signal)
  }

  const create = async () => {
    if (busy) return
    if (!accessToken) return
    const name = newName.trim()
    const invalid = skillNameError(name)
    if (invalid) return setMessage(userMessage(new BotDefaultToolError(invalid)))
    if (skills.some((skill) => skill.skillName === name)) return setMessage(botCopy("A Skill with this name already exists. Open it from the list instead.", "已有相同名稱的 Skill，請從清單開啟。"))
    if (dirty && !window.confirm(botCopy("Discard unsaved Skill edits and create a new Skill?", "要放棄尚未儲存的 Skill 修改，並建立新的 Skill 嗎？"))) return
    setReading(true)
    setError("")
    let revision = 0
    let deleted = false
    let nextRevisions: OwnedSkillRevision[] = []
    try {
      const existing = await readOwnedSkill(accessToken, botId, name)
      if (!existing.skill.deleted) {
        setMessage(botCopy("A Skill with this name already exists. Open it from the list instead.", "已有相同名稱的 Skill，請從清單開啟。"))
        return
      }
      revision = existing.skill.revision
      deleted = existing.skill.deleted === true
      nextRevisions = existing.revisions ?? []
    } catch (cause) {
      if (!isNotFound(cause)) {
        setMessage(userMessage(cause))
        setSignInRequired(needsSignIn(cause))
        return
      }
    } finally {
      setReading(false)
    }
    const skill: OwnedSkill = { skillName: name, revision, deleted: deleted || undefined, files: [{ path: "SKILL.md", content: defaultDescriptor(name, newDescription.trim()) }] }
    setSelectedName(name)
    setLoadedSkill(skill)
    setFiles(filesAsRecord(skill))
    setSelectedPath("SKILL.md")
    setRevisions(nextRevisions)
    setMessage(revision > 0
      ? botCopy("A previously deleted Skill is ready to recreate. Save it when the instructions are ready.", "已載入先前刪除的 Skill 版本，可重新建立；完成指引後請儲存。")
      : botCopy("New Skill is ready to edit. Save it when the instructions are ready.", "新的 Skill 已可編輯。完成指引後請儲存。"))
  }

  const addFile = () => {
    if (busy) return
    const path = newPath.trim()
    if (!/^scripts\/[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(path)) {
      setMessage(botCopy("Use a script path such as scripts/check-status.ts.", "請使用 scripts/check-status.ts 這類檔案路徑。"))
      return
    }
    if (files[path] !== undefined) {
      setSelectedPath(path)
      return
    }
    setFiles((current) => ({ ...current, [path]: "" }))
    setSelectedPath(path)
    setNewPath("")
  }

  const save = async () => {
    if (busy || !accessToken || !loadedSkill) return
    setSaving(true)
    setMessage("")
    setNeedsReload(false)
    try {
      const result = await writeOwnedSkill(accessToken, botId, { skillName: loadedSkill.skillName, expectedRevision: loadedSkill.revision, files })
      setLoadedSkill(result.skill)
      setFiles(filesAsRecord(result.skill))
      setSelectedPath((current) => result.skill.files.some((file) => file.path === current) ? current : "SKILL.md")
      setSkills((current) => {
        const next = current.filter((skill) => skill.skillName !== result.skill.skillName)
        return [...next, { skillName: result.skill.skillName, revision: result.skill.revision, updatedAt: result.skill.updatedAt ?? Date.now() }].sort((a, b) => a.skillName.localeCompare(b.skillName))
      })
      setMessage(botCopy(`Saved revision ${result.skill.revision}. It will load on the Bot's next work.`, `已儲存版本 ${result.skill.revision}。Bot 下次工作時會載入。`))
      await read(result.skill.skillName, undefined, false)
    } catch (cause) {
      setMessage(userMessage(cause))
      setSignInRequired(needsSignIn(cause))
      setNeedsReload(isRevisionConflict(cause))
    } finally {
      setSaving(false)
    }
  }

  const revert = async (revision: number) => {
    if (busy || !accessToken || !loadedSkill) return
    setSaving(true)
    setMessage("")
    setNeedsReload(false)
    try {
      const result = await revertOwnedSkill(accessToken, botId, { skillName: loadedSkill.skillName, revision, expectedRevision: loadedSkill.revision })
      setLoadedSkill(result.skill)
      setFiles(filesAsRecord(result.skill))
      setSelectedPath("SKILL.md")
      setMessage(botCopy(`Reverted and saved as revision ${result.skill.revision}. It will load on the Bot's next work.`, `已回復並儲存為版本 ${result.skill.revision}。Bot 下次工作時會載入。`))
      await read(result.skill.skillName, undefined, false)
      await loadList()
    } catch (cause) {
      setMessage(userMessage(cause))
      setSignInRequired(needsSignIn(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bot-owned-skills-panel" aria-labelledby="bot-owned-skills-title">
      <header className="bot-default-tools-header">
        <span><h3 id="bot-owned-skills-title">{botCopy("Owned Skills", "自有 Skills")}</h3><p>{botCopy("Write Bot-specific instructions without changing installed Skills. Saved revisions load on the next Bot work.", "可撰寫 Bot 專屬指引，不會修改已安裝的 Skills。已儲存的版本會在 Bot 下次工作時載入。")}</p></span>
        <button type="button" className="secondary-button" onClick={() => void loadList()} disabled={!signedIn || loading || busy}><RefreshCw />{botCopy("Refresh", "重新載入")}</button>
      </header>
      {(!signedIn || signInRequired) && <div className="bot-default-tools-notice" role="alert"><span>{botCopy("Sign in to view and manage owned Skills.", "請登入後查看及管理自有 Skills。")}</span><button type="button" className="secondary-button" onClick={() => void beginGenioLogin({ forceReauthentication: true })}>{botCopy("Sign in", "重新登入")}</button></div>}
      {error && <div className="bot-default-tools-error" role="alert">{error}<button type="button" className="secondary-button" onClick={() => void loadList()}>{botCopy("Retry", "重試")}</button></div>}
      {message && <p className="bot-default-tools-message" role="status">{message}</p>}
      {needsReload && <button type="button" className="secondary-button" onClick={reloadCurrentSkill} disabled={busy}>{botCopy("Reload saved Skill", "重新載入已儲存 Skill")}</button>}
      <div className="owned-skill-workspace">
        <aside className="owned-skill-list" aria-label={botCopy("Owned Skills", "自有 Skills")}>
          <strong>{botCopy("Saved Skills", "已儲存 Skills")}</strong>
          {loading || reading ? <p><LoaderCircle className="spin" />{botCopy("Loading…", "載入中…")}</p> : skills.length === 0 ? <p>{botCopy("No owned Skills yet.", "目前沒有自有 Skill。")}</p> : skills.map((skill) => <button type="button" key={skill.skillName} className={selectedName === skill.skillName ? "active" : ""} onClick={() => chooseSkill(skill.skillName)} disabled={busy}><FileCode2 /><span>{skill.skillName}<small>v{skill.revision} · {humanUpdatedAt(skill.updatedAt)}</small></span></button>)}
          <div className="owned-skill-create"><strong>{botCopy("Create Skill", "建立 Skill")}</strong><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="release-check" disabled={busy}/><input value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder={botCopy("Short description", "簡短說明")} disabled={busy}/><button type="button" className="secondary-button" onClick={() => void create()} disabled={!signedIn || busy}><Plus />{botCopy("Create", "建立")}</button></div>
        </aside>
        <div className="owned-skill-editor">
          {!loadedSkill ? <p className="owned-skill-empty">{botCopy("Choose a saved Skill or create one to start editing its instructions.", "選擇已儲存的 Skill，或建立新的 Skill 以開始編輯指引。")}</p> : <>
            <header><span><strong>{loadedSkill.skillName}</strong><small>{dirty ? botCopy("Unsaved changes", "尚未儲存的修改") : botCopy(`Saved revision ${loadedSkill.revision}`, `已儲存版本 ${loadedSkill.revision}`)}</small></span><div className="bot-default-tools-actions"><button type="button" className="primary-button" onClick={() => void save()} disabled={busy || !dirty}>{saving && <LoaderCircle className="spin" />}<Save />{botCopy("Save", "儲存")}</button></div></header>
            <div className="owned-skill-file-controls"><label><span>{botCopy("File", "檔案")}</span><select value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)} disabled={busy}>{Object.keys(files).sort().map((path) => <option key={path} value={path}>{path}</option>)}</select></label><label><span>{botCopy("Add script file", "新增腳本檔")}</span><div><input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="scripts/check-status.ts" disabled={busy}/><button type="button" className="secondary-button" onClick={addFile} disabled={busy}><FilePlus2 />{botCopy("Add", "新增")}</button></div></label></div>
            <textarea className="owned-skill-source" value={files[selectedPath] ?? ""} onChange={(event) => setFiles((current) => ({ ...current, [selectedPath]: event.target.value }))} aria-label={selectedPath} disabled={busy}/>
            <div className="owned-skill-history"><span><History />{botCopy("Saved versions", "已儲存版本")}</span>{revisions.filter((revision) => !revision.deleted && revision.revision < loadedSkill.revision).map((revision) => <button type="button" key={revision.revision} className="secondary-button" disabled={busy || dirty} onClick={() => void revert(revision.revision)}>{botCopy(`Revert to v${revision.revision}`, `回復至 v${revision.revision}`)}</button>)}{dirty && <small>{botCopy("Save or reload the current Skill before reverting a version.", "請先儲存或重新載入目前 Skill，再回復版本。")}</small>}</div>
          </>}
        </div>
      </div>
    </section>
  )
}
