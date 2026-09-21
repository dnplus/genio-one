import { CalendarClock, LoaderCircle, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  BotDefaultToolError,
  createSchedule,
  deleteSchedule,
  listSchedules,
  type BotSchedule,
  type BotScheduleRun,
  type OnceSchedule,
  type RecurringSchedule,
  updateSchedule,
} from "../../lib/bot-default-tools-api"
import { beginGenioLogin } from "../../lib/genio-one"
import { botCopy } from "../../lib/ui-copy"
import "./BotSchedulesPanel.css"

type Weekday = NonNullable<RecurringSchedule["weekdays"]>[number]
type ScheduleKind = "once" | "daily" | "weekly"

export interface ScheduleDraft {
  prompt: string
  kind: ScheduleKind
  onceAt: string
  time: string
  timezone: string
  weekdays: Weekday[]
}

const WEEKDAYS: Array<{ value: Weekday; english: string; traditionalChinese: string }> = [
  { value: "MO", english: "Mon", traditionalChinese: "一" },
  { value: "TU", english: "Tue", traditionalChinese: "二" },
  { value: "WE", english: "Wed", traditionalChinese: "三" },
  { value: "TH", english: "Thu", traditionalChinese: "四" },
  { value: "FR", english: "Fri", traditionalChinese: "五" },
  { value: "SA", english: "Sat", traditionalChinese: "六" },
  { value: "SU", english: "Sun", traditionalChinese: "日" },
]

function localDateTime(value: string | number | null | undefined) {
  if (value === null || value === undefined) return ""
  const date = new Date(typeof value === "number" ? value : value)
  if (Number.isNaN(date.getTime())) return ""
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

function defaultTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei" } catch { return "Asia/Taipei" }
}

export function blankScheduleDraft(): ScheduleDraft {
  return { prompt: "", kind: "once", onceAt: "", time: "09:00", timezone: defaultTimezone(), weekdays: ["MO"] }
}

export function scheduleDraftFrom(schedule: BotSchedule["schedule"]): ScheduleDraft {
  if (schedule.kind === "once") {
    return { ...blankScheduleDraft(), kind: "once", onceAt: localDateTime(schedule.at) }
  }
  return {
    ...blankScheduleDraft(),
    kind: schedule.frequency,
    time: schedule.time,
    timezone: schedule.timezone,
    weekdays: schedule.weekdays?.length ? schedule.weekdays : ["MO"],
  }
}

function sameDraftValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function rebaseScheduleDraft(base: ScheduleDraft, current: ScheduleDraft, latest: ScheduleDraft): ScheduleDraft {
  const value = <T,>(baseValue: T, currentValue: T, latestValue: T) => sameDraftValue(baseValue, currentValue) ? latestValue : currentValue
  const timing = (draft: ScheduleDraft) => ({ kind: draft.kind, onceAt: draft.onceAt, time: draft.time, timezone: draft.timezone, weekdays: draft.weekdays })
  const kindChanged = base.kind !== current.kind || base.kind !== latest.kind
  if (kindChanged) {
    const nextTiming = sameDraftValue(timing(base), timing(current)) ? timing(latest) : timing(current)
    return { prompt: value(base.prompt, current.prompt, latest.prompt), ...nextTiming }
  }
  return {
    prompt: value(base.prompt, current.prompt, latest.prompt),
    kind: current.kind,
    onceAt: value(base.onceAt, current.onceAt, latest.onceAt),
    time: value(base.time, current.time, latest.time),
    timezone: value(base.timezone, current.timezone, latest.timezone),
    weekdays: value(base.weekdays, current.weekdays, latest.weekdays),
  }
}

export function validateScheduleDraft(draft: ScheduleDraft): string | null {
  if (!draft.prompt.trim()) return "SCHEDULE_PROMPT_REQUIRED"
  if (draft.kind === "once") {
    const at = new Date(draft.onceAt)
    if (!draft.onceAt || Number.isNaN(at.getTime())) return "SCHEDULE_ONCE_AT_INVALID"
    if (at.getTime() <= Date.now()) return "SCHEDULE_ONCE_AT_PAST"
    return null
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return "SCHEDULE_TIME_INVALID"
  try { Intl.DateTimeFormat(undefined, { timeZone: draft.timezone }) } catch { return "SCHEDULE_TIMEZONE_INVALID" }
  if (draft.kind === "weekly" && draft.weekdays.length === 0) return "SCHEDULE_WEEKDAYS_REQUIRED"
  return null
}

export function scheduleFromDraft(draft: ScheduleDraft): OnceSchedule | RecurringSchedule {
  if (draft.kind === "once") return { kind: "once", at: new Date(draft.onceAt).toISOString() }
  return {
    kind: "recurring",
    frequency: draft.kind,
    time: draft.time,
    timezone: draft.timezone.trim(),
    ...(draft.kind === "weekly" ? { weekdays: draft.weekdays } : {}),
  }
}

function scheduleDescription(schedule: BotSchedule["schedule"]) {
  if (schedule.kind === "once") return botCopy(`Once · ${new Date(schedule.at).toLocaleString()}`, `一次性 · ${new Date(schedule.at).toLocaleString()}`)
  const frequency = schedule.frequency === "daily" ? botCopy("Daily", "每天") : botCopy("Weekly", "每週")
  const weekdays = schedule.frequency === "weekly"
    ? ` · ${(schedule.weekdays ?? []).map((day) => WEEKDAYS.find((item) => item.value === day)?.traditionalChinese ?? day).join("、")}`
    : ""
  return `${frequency} · ${schedule.time} · ${schedule.timezone}${weekdays}`
}

function timestamp(value: number | string | null | undefined) {
  if (value === null || value === undefined) return botCopy("Not scheduled", "尚未排定")
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? botCopy("Not scheduled", "尚未排定") : parsed.toLocaleString()
}

function userMessage(error: unknown) {
  const code = error instanceof BotDefaultToolError ? error.code : error instanceof Error ? error.message : ""
  if (/AUTH|TOKEN|UNAUTHORIZED|SIGN_IN|SESSION/i.test(code)) return botCopy("Your sign-in has expired. Sign in again, then retry.", "登入已過期，請重新登入後再試。")
  if (/BOT_SCHEDULE_CHANGED|REVISION_CONFLICT|CONFLICT/i.test(code)) return botCopy("This schedule changed elsewhere. Refresh, review the latest version, then save your edits again.", "此排程已在其他地方更新。請重新載入、確認最新內容後，再儲存你的修改。")
  if (/PROMPT_REQUIRED/i.test(code)) return botCopy("Enter the work the Bot should perform.", "請輸入要讓 Bot 執行的工作。")
  if (/PAST|AT_INVALID|TIME_INVALID|TIMEZONE_INVALID|WEEKDAYS_REQUIRED/i.test(code)) return botCopy("Check the schedule date, time, and timezone.", "請確認排程日期、時間與時區。")
  return botCopy("The schedule could not be updated. Your edits are still here; try again shortly.", "排程尚未更新。你的修改已保留，請稍後再試。")
}

function needsSignIn(error: unknown) {
  const code = error instanceof BotDefaultToolError ? error.code : error instanceof Error ? error.message : ""
  return /AUTH|TOKEN|UNAUTHORIZED|SIGN_IN|SESSION/i.test(code)
}

function isRevisionConflict(error: unknown) {
  const code = error instanceof BotDefaultToolError ? error.code : error instanceof Error ? error.message : ""
  return /BOT_SCHEDULE_CHANGED|REVISION_CONFLICT|CONFLICT/i.test(code)
}

function runFor(scheduleId: string, runs: BotScheduleRun[]) {
  return runs.find((run) => run.scheduleId === scheduleId)
}

function runStatusCopy(state: string) {
  switch (state) {
    case "QUEUED": return botCopy("Queued", "等待執行")
    case "CLAIMED": return botCopy("Preparing", "準備執行")
    case "STARTING": return botCopy("Starting", "啟動中")
    case "RUNNING": return botCopy("Running", "執行中")
    case "COMPLETED": return botCopy("Completed", "已完成")
    case "AUTH_REQUIRED": return botCopy("Sign-in required", "需要重新登入")
    case "BLOCKED": return botCopy("Needs attention", "需要處理")
    case "FAILED": return botCopy("Failed", "執行失敗")
    case "UNCERTAIN": return botCopy("Checking result", "等待核對執行結果")
    default: return botCopy("Status unavailable", "狀態暫時無法確認")
  }
}

function runGuidance(state: string, error: string | null) {
  if (error === "SCHEDULE_PACKAGE_CAPABILITIES_UNAVAILABLE") return botCopy("This Bot has installed tools that cannot run on a schedule yet. Run this task from chat.", "這隻 Bot 已安裝的工具目前尚不支援排程，請從聊天執行這項工作。")
  switch (state) {
    case "AUTH_REQUIRED": return botCopy("Sign in again. The scheduler will catch up only the latest eligible run.", "請重新登入。系統只會補跑最新一次符合條件的工作。")
    case "UNCERTAIN": return botCopy("The result is being checked. This run will not be sent again yet.", "正在核對結果，這次工作暫不會重送。")
    case "BLOCKED": return botCopy("Check sign-in, access, and whether the schedule is paused, then wait for the next eligible run.", "請確認登入、權限與排程是否暫停，再等待下一次符合條件的執行。")
    case "FAILED": return botCopy("This run did not complete. Check the schedule and access before its next eligible run.", "這次工作未完成。請在下次符合條件的執行前確認排程及權限。")
    default: return ""
  }
}

export function BotSchedulesPanel({ botId, accessToken, onBusyChange, onDirtyChange }: { botId: string; accessToken?: string; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [schedules, setSchedules] = useState<BotSchedule[]>([])
  const [runs, setRuns] = useState<BotScheduleRun[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [editing, setEditing] = useState<BotSchedule | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<ScheduleDraft>(() => blankScheduleDraft())
  const [saving, setSaving] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [signInRequired, setSignInRequired] = useState(() => !accessToken)
  const [needsRebase, setNeedsRebase] = useState(false)
  const creationRequestIdRef = useRef<string | null>(null)
  const editingRef = useRef<BotSchedule | null>(null)
  const draftBaseRef = useRef<ScheduleDraft | null>(null)
  const editorSessionRef = useRef(0)

  const signedIn = Boolean(accessToken)
  useEffect(() => { onBusyChange?.(saving) }, [saving, onBusyChange])
  const hasUnsavedDraft = Boolean((editing || creating) && draftBaseRef.current && JSON.stringify(draft) !== JSON.stringify(draftBaseRef.current))
  useEffect(() => { onDirtyChange?.(hasUnsavedDraft) }, [hasUnsavedDraft, onDirtyChange])
  const confirmDiscardDraft = () => !hasUnsavedDraft || window.confirm(botCopy("Discard unsaved schedule edits?", "要放棄尚未儲存的排程修改嗎？"))
  const sortedSchedules = useMemo(() => [...schedules].sort((a, b) => String(a.nextRunAt ?? "").localeCompare(String(b.nextRunAt ?? ""))), [schedules])

  const load = useCallback(async (signal?: AbortSignal, rebaseEditing = false) => {
    if (!accessToken) return
    const rebaseContext = rebaseEditing && editingRef.current ? {
      scheduleId: editingRef.current.id,
      revision: editingRef.current.revision,
      base: draftBaseRef.current,
      session: editorSessionRef.current,
    } : null
    setLoading(true)
    setError("")
    try {
      const value = await listSchedules(accessToken, botId, signal)
      if (signal?.aborted) return
      setSchedules(value.schedules)
      setRuns(value.runs)
      setSignInRequired(false)
      if (rebaseContext) {
        const latest = value.schedules.find((schedule) => schedule.id === rebaseContext.scheduleId)
        if (latest && latest.revision >= rebaseContext.revision && editingRef.current?.id === rebaseContext.scheduleId && editorSessionRef.current === rebaseContext.session) {
          const latestDraft = { ...scheduleDraftFrom(latest.schedule), prompt: latest.prompt }
          draftBaseRef.current = latestDraft
          setDraft((current) => rebaseScheduleDraft(rebaseContext.base ?? current, current, latestDraft))
          editingRef.current = latest
          setEditing(latest)
          setNeedsRebase(false)
          setMessage(botCopy("Latest schedule version loaded. Your edits are still here; review them, then save again.", "已載入最新排程版本。你的修改仍保留，請確認後再儲存。"))
        }
      }
    } catch (cause) {
      if (!signal?.aborted) {
        setError(userMessage(cause))
        setSignInRequired(needsSignIn(cause))
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [accessToken, botId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const beginCreate = () => {
    if (saving) return
    if (!confirmDiscardDraft()) return
    const nextDraft = blankScheduleDraft()
    editorSessionRef.current++
    setEditing(null)
    editingRef.current = null
    setCreating(true)
    creationRequestIdRef.current = crypto.randomUUID()
    draftBaseRef.current = nextDraft
    setNeedsRebase(false)
    setDraft(nextDraft)
    setMessage("")
  }

  const beginEdit = (schedule: BotSchedule) => {
    if (saving) return
    if (!confirmDiscardDraft()) return
    const nextDraft = { ...scheduleDraftFrom(schedule.schedule), prompt: schedule.prompt }
    editorSessionRef.current++
    setEditing(schedule)
    editingRef.current = schedule
    setCreating(false)
    creationRequestIdRef.current = null
    draftBaseRef.current = nextDraft
    setNeedsRebase(false)
    setDraft(nextDraft)
    setMessage("")
  }

  const closeEditor = () => {
    if (saving) return
    editorSessionRef.current++
    setEditing(null)
    editingRef.current = null
    setCreating(false)
    creationRequestIdRef.current = null
    draftBaseRef.current = null
    setNeedsRebase(false)
    setDraft(blankScheduleDraft())
    setMessage("")
  }

  const changeDraft = (update: (current: ScheduleDraft) => ScheduleDraft) => {
    if (!editing && !creating) {
      draftBaseRef.current = draft
      creationRequestIdRef.current = crypto.randomUUID()
      setCreating(true)
    }
    setDraft(update)
  }

  const save = async () => {
    if (saving || loading) return
    if (!accessToken) {
      setMessage(userMessage(new BotDefaultToolError("AUTH_REQUIRED")))
      return
    }
    const validation = validateScheduleDraft(draft)
    if (validation) {
      setMessage(userMessage(new BotDefaultToolError(validation)))
      return
    }
    setSaving(true)
    setMessage("")
    try {
      if (editing) {
        await updateSchedule(accessToken, botId, {
          scheduleId: editing.id,
          expectedRevision: editing.revision,
          prompt: draft.prompt.trim(),
          schedule: scheduleFromDraft(draft),
        })
        setMessage(botCopy("Saved. The next eligible run will use this schedule.", "已儲存。下一次符合條件的執行會使用此排程。"))
      } else {
        const clientRequestId = creationRequestIdRef.current ?? crypto.randomUUID()
        creationRequestIdRef.current = clientRequestId
        const created = await createSchedule(accessToken, botId, {
          clientRequestId,
          prompt: draft.prompt.trim(),
          schedule: scheduleFromDraft(draft),
        })
        if (created.deleted || !created.schedule) {
          setMessage(botCopy("This schedule was deleted before it could be confirmed. No new schedule was created.", "這個排程已在確認前被刪除，沒有建立新的排程。"))
        } else {
          setMessage(created.created
            ? botCopy("Schedule saved. It will run only when due and authorized.", "排程已儲存。到期且仍獲授權時才會執行。")
            : botCopy("The earlier save was confirmed. No duplicate schedule was created.", "已確認先前的儲存，沒有建立重複排程。"))
        }
      }
      await load()
      editorSessionRef.current++
      setEditing(null)
      editingRef.current = null
      setCreating(false)
      creationRequestIdRef.current = null
      draftBaseRef.current = null
      setNeedsRebase(false)
      setDraft(blankScheduleDraft())
    } catch (cause) {
      setMessage(userMessage(cause))
      setSignInRequired(needsSignIn(cause))
      setNeedsRebase(isRevisionConflict(cause))
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (schedule: BotSchedule) => {
    if (saving) return
    if (!accessToken) return setMessage(userMessage(new BotDefaultToolError("AUTH_REQUIRED")))
    setActionId(schedule.id)
    setMessage("")
    try {
      await updateSchedule(accessToken, botId, { scheduleId: schedule.id, expectedRevision: schedule.revision, enabled: !schedule.enabled })
      await load()
    } catch (cause) {
      setMessage(userMessage(cause))
      setSignInRequired(needsSignIn(cause))
    } finally {
      setActionId(null)
    }
  }

  const remove = async (schedule: BotSchedule) => {
    if (saving) return
    if (!accessToken) return setMessage(userMessage(new BotDefaultToolError("AUTH_REQUIRED")))
    if (!window.confirm(botCopy("Delete this schedule? Its future runs will be removed.", "要刪除此排程嗎？後續執行將被移除。"))) return
    setActionId(schedule.id)
    setMessage("")
    try {
      await deleteSchedule(accessToken, botId, { scheduleId: schedule.id, expectedRevision: schedule.revision })
      await load()
      if (editing?.id === schedule.id) closeEditor()
    } catch (cause) {
      setMessage(userMessage(cause))
      setSignInRequired(needsSignIn(cause))
    } finally {
      setActionId(null)
    }
  }

  return (
    <section className="bot-schedules-panel" aria-labelledby="bot-schedules-title">
      <header className="bot-default-tools-header">
        <span>
          <h3 id="bot-schedules-title">{botCopy("Schedules", "排程")}</h3>
          <p>{botCopy("Schedules continue after you close this page. Sign in again if your session expires. Saving is not proof that a run completed.", "關閉此頁後排程仍可執行；登入過期時請重新登入。儲存排程不代表工作已完成。")}</p>
        </span>
        <div className="bot-default-tools-actions">
          <button type="button" className="secondary-button" onClick={() => void load(undefined, true)} disabled={!signedIn || loading || saving}><RefreshCw />{botCopy("Refresh", "重新載入")}</button>
          <button type="button" className="primary-button" onClick={beginCreate} disabled={!signedIn || saving}><Plus />{botCopy("New schedule", "新增排程")}</button>
        </div>
      </header>

      {(!signedIn || signInRequired) && <div className="bot-default-tools-notice" role="alert"><span>{botCopy("Sign in to view and manage schedules.", "請登入後查看及管理排程。")}</span><button type="button" className="secondary-button" onClick={() => void beginGenioLogin({ forceReauthentication: true })}>{botCopy("Sign in", "重新登入")}</button></div>}
      {error && <div className="bot-default-tools-error" role="alert">{error}<button type="button" className="secondary-button" onClick={() => void load()} disabled={saving}>{botCopy("Retry", "重試")}</button></div>}
      {message && <p className="bot-default-tools-message" role="status">{message}{needsRebase && <button type="button" className="secondary-button" onClick={() => void load(undefined, true)} disabled={loading || saving}>{botCopy("Reload latest version", "重新載入最新版本")}</button>}</p>}

      {(editing || creating || (!loading && signedIn && schedules.length === 0 && !error)) && (
        <form className="schedule-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <div className="schedule-editor-heading"><strong>{editing ? botCopy("Edit schedule", "編輯排程") : botCopy("New schedule", "新增排程")}</strong>{editing && <button type="button" className="text-button" onClick={closeEditor} disabled={saving}>{botCopy("Cancel", "取消")}</button>}</div>
          <label><span>{botCopy("Work for the Bot", "要讓 Bot 執行的工作")}</span><textarea value={draft.prompt} onChange={(event) => changeDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder={botCopy("For example: summarize the new tickets and report exceptions", "例如：彙整新的客服案件並回報例外")} disabled={saving}/></label>
          <div className="schedule-form-grid">
            <label><span>{botCopy("When", "執行時間")}</span><select value={draft.kind} onChange={(event) => changeDraft((current) => ({ ...current, kind: event.target.value as ScheduleKind }))} disabled={saving}><option value="once">{botCopy("Once", "一次性")}</option><option value="daily">{botCopy("Every day", "每天")}</option><option value="weekly">{botCopy("Every week", "每週")}</option></select></label>
            {draft.kind === "once" ? <label><span>{botCopy("Date and time", "日期與時間")}</span><input type="datetime-local" value={draft.onceAt} onChange={(event) => changeDraft((current) => ({ ...current, onceAt: event.target.value }))} disabled={saving}/></label> : <><label><span>{botCopy("Time", "時間")}</span><input type="time" value={draft.time} onChange={(event) => changeDraft((current) => ({ ...current, time: event.target.value }))} disabled={saving}/></label><label><span>{botCopy("Timezone", "時區")}</span><input value={draft.timezone} onChange={(event) => changeDraft((current) => ({ ...current, timezone: event.target.value }))} placeholder="Asia/Taipei" disabled={saving}/></label></>}
          </div>
          {draft.kind === "weekly" && <fieldset><legend>{botCopy("Days", "星期")}</legend><div className="weekday-picker">{WEEKDAYS.map((day) => <label key={day.value}><input type="checkbox" checked={draft.weekdays.includes(day.value)} onChange={() => changeDraft((current) => ({ ...current, weekdays: current.weekdays.includes(day.value) ? current.weekdays.filter((value) => value !== day.value) : [...current.weekdays, day.value] }))} disabled={saving}/><span>{botCopy(day.english, day.traditionalChinese)}</span></label>)}</div></fieldset>}
          <div className="setting-actions"><button type="button" className="secondary-button" onClick={closeEditor} disabled={saving}>{botCopy("Cancel", "取消")}</button><button type="submit" className="primary-button" disabled={saving || loading}>{saving && <LoaderCircle className="spin" />}{editing ? botCopy("Save changes", "儲存變更") : botCopy("Save schedule", "儲存排程")}</button></div>
        </form>
      )}

      {loading ? <p className="bot-default-tools-loading"><LoaderCircle className="spin" />{botCopy("Loading schedules…", "正在載入排程…")}</p> : sortedSchedules.map((schedule) => {
        const run = runFor(schedule.id, runs)
        const busy = actionId === schedule.id || saving
        return <article className="schedule-row" key={schedule.id}>
          <CalendarClock aria-hidden="true" />
          <div className="schedule-row-copy"><strong>{schedule.prompt}</strong><small>{scheduleDescription(schedule.schedule)}</small><small>{botCopy("Next run", "下次執行")}：{timestamp(schedule.nextRunAt)} · {schedule.enabled ? botCopy("Enabled", "已啟用") : botCopy("Paused", "已暫停")}</small>{run && <small>{botCopy("Latest run", "最近執行")}：{runStatusCopy(run.state)} · {timestamp(run.updatedAt)}{runGuidance(run.state, run.error) ? ` · ${runGuidance(run.state, run.error)}` : ""}</small>}</div>
          <div className="schedule-row-actions"><button type="button" className="secondary-button" onClick={() => beginEdit(schedule)} disabled={busy}><Pencil />{botCopy("Edit", "編輯")}</button><button type="button" className="secondary-button" onClick={() => void toggleEnabled(schedule)} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Play />}{schedule.enabled ? botCopy("Pause", "暫停") : botCopy("Resume", "恢復")}</button><button type="button" className="icon-button schedule-delete-button" aria-label={botCopy("Delete schedule", "刪除排程")} title={botCopy("Delete schedule", "刪除排程")} onClick={() => void remove(schedule)} disabled={busy}><Trash2 /></button></div>
        </article>
      })}
    </section>
  )
}
