import { useEffect, useRef, useState } from "react"
import { Mic, Square, X, RefreshCw } from "lucide-react"

import { botCopy } from "../../lib/ui-copy"
import "./VoiceInput.css"

type State = "idle" | "starting" | "recording" | "transcribing" | "error"
const messages: Record<string, string> = {
  ASR_NOT_CONFIGURED: "預設語音模型尚未就緒，請確認 Breeze ASR 已啟用並取得使用權限。",
  ASR_AUTH_REQUIRED: "登入已過期，請重新登入。",
  ASR_BUSY: "語音服務忙碌中，請稍後重試。",
  ASR_ACCESS_DENIED: "目前沒有這個語音模型的使用權限。",
  ASR_INVALID_AUDIO: "錄音格式無法辨識，請重新錄音。",
  ASR_AUDIO_TOO_LARGE: "錄音超過大小限制，請縮短後重新錄音。",
}

export function VoiceInput({ token, disabled, onTranscript, onBusyChange, demo }: {
  token: string
  disabled: boolean
  onTranscript: (text: string) => void
  onBusyChange: (busy: boolean) => void
  demo?: boolean
}) {
  const [state, setState] = useState<State>("idle")
  const [error, setError] = useState("")
  const [seconds, setSeconds] = useState(0)
  const [modelName, setModelName] = useState("")
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const recording = useRef<Blob | null>(null)
  const callbacks = useRef({ onTranscript, onBusyChange })
  callbacks.current = { onTranscript, onBusyChange }

  function releaseMicrophone() {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
  }

  function cancel() {
    generation.current++
    request.current?.abort()
    if (recorder.current?.state === "recording") recorder.current.stop()
    releaseMicrophone()
    recording.current = null
    callbacks.current.onBusyChange(false)
    setState("idle")
    setError("")
  }

  useEffect(() => {
    cancel()
    return () => {
      generation.current++
      request.current?.abort()
      if (recorder.current?.state === "recording") recorder.current.stop()
      releaseMicrophone()
    }
  }, [token])

  async function transcribe(blob: Blob, run: number) {
    setState("transcribing")
    setError("")
    callbacks.current.onBusyChange(true)
    const controller = new AbortController()
    request.current = controller
    try {
      const response = await fetch("/api/transcription", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": blob.type }, body: blob, signal: controller.signal,
      })
      if (response.status === 413) throw new Error("ASR_AUDIO_TOO_LARGE")
      const result = await response.json() as { text?: string; error?: string }
      if (!response.ok) throw new Error(result.error)
      if (run !== generation.current) return
      if (!result.text?.trim()) throw new Error("ASR_EMPTY")
      callbacks.current.onTranscript(result.text.trim())
      recording.current = null
      setState("idle")
    } catch (caught) {
      if (run !== generation.current) return
      const code = caught instanceof Error ? caught.message : ""
      setError(code === "ASR_EMPTY" ? "沒有辨識到語音，請重新錄音。" : messages[code] ?? "語音辨識失敗，錄音仍保留，可重試或取消。")
      setState("error")
    } finally {
      if (run === generation.current) callbacks.current.onBusyChange(false)
    }
  }

  function finishDemoRecording() {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    releaseMicrophone()
    setState("transcribing")
    setTimeout(() => {
      callbacks.current.onTranscript("這是一段語音輸入測試，已透過 ASR 辨識並輸入至對話框。")
      callbacks.current.onBusyChange(false)
      setState("idle")
    }, 600)
  }

  async function start() {
    const run = ++generation.current
    recording.current = null
    setError("")
    setState("starting")
    callbacks.current.onBusyChange(true)
    try {
      if (demo || token === "demo") {
        setModelName("展示語音辨識")
        let media: MediaStream | null = null
        try {
          if (navigator.mediaDevices?.getUserMedia) {
            media = await navigator.mediaDevices.getUserMedia({ audio: true })
          }
        } catch {}
        if (run !== generation.current) { media?.getTracks().forEach((track) => track.stop()); return }
        stream.current = media
        setSeconds(0)
        setState("recording")
        const started = Date.now()
        timer.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - started) / 1000)
          setSeconds(elapsed)
          if (elapsed >= 5) {
            finishDemoRecording()
          }
        }, 250)
        return
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("ASR_BROWSER_UNSUPPORTED")
      const controller = new AbortController()
      request.current = controller
      const response = await fetch("/api/transcription", { headers: { authorization: `Bearer ${token}` }, signal: controller.signal, cache: "no-store" })
      const configuration = await response.json() as { available?: boolean; displayName?: string; error?: string }
      if (!response.ok) throw new Error(configuration.error)
      if (!configuration.available) throw new Error("ASR_NOT_CONFIGURED")
      if (run !== generation.current) return
      setModelName(configuration.displayName ?? "語音模型")
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (run !== generation.current) { media.getTracks().forEach((track) => track.stop()); return }
      stream.current = media
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type))
      if (!mimeType) throw new Error("ASR_BROWSER_UNSUPPORTED")
      const next = new MediaRecorder(media, { mimeType, audioBitsPerSecond: 64000 })
      recorder.current = next
      const chunks: Blob[] = []
      next.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      next.onerror = () => {
        if (run !== generation.current) return
        generation.current++
        releaseMicrophone()
        callbacks.current.onBusyChange(false)
        setState("error")
        setError("錄音中斷，請重新錄音。")
      }
      next.onstop = () => {
        if (run !== generation.current) return
        releaseMicrophone()
        const blob = new Blob(chunks, { type: mimeType })
        if (!blob.size || blob.size > 3_500_000) {
          setState("error")
          setError(blob.size ? messages.ASR_AUDIO_TOO_LARGE! : "未取得錄音，請重新錄音。")
          callbacks.current.onBusyChange(false)
          return
        }
        recording.current = blob
        void transcribe(blob, run)
      }
      next.start(1000)
      setSeconds(0)
      setState("recording")
      const started = Date.now()
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000)
        setSeconds(elapsed)
        if (elapsed >= 60 && next.state === "recording") next.stop()
      }, 250)
    } catch (caught) {
      if (run !== generation.current) return
      releaseMicrophone()
      const code = caught instanceof Error ? caught.message : ""
      setError(caught instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(caught.name)
        ? "麥克風未獲授權，請在瀏覽器允許後重試。"
        : code === "ASR_BROWSER_UNSUPPORTED" ? "這個瀏覽器無法錄音，請使用支援錄音的瀏覽器與 HTTPS 或本機入口。"
          : messages[code] ?? "無法開始錄音，請確認麥克風與語音服務後重試。")
      setState("error")
      callbacks.current.onBusyChange(false)
    }
  }

  const busy = state === "starting" || state === "recording" || state === "transcribing"
  return <div className="voice-input">
    <button type="button" className={`voice-input-button ${state === "recording" ? "is-recording" : ""}`} disabled={(!busy && (disabled || (!token && !demo))) || state === "starting" || state === "transcribing"}
      onClick={() => state === "recording" ? ((demo || token === "demo") ? finishDemoRecording() : recorder.current?.stop()) : void start()}
      aria-label={state === "recording" ? "停止錄音並辨識" : botCopy("Voice input", "語音輸入")} title={botCopy("Voice input, up to 60 seconds", "語音輸入，最長 60 秒")}>
      {state === "recording" ? <Square size={16} /> : <Mic size={16} />}
    </button>
    {busy && <span role="status" className="voice-input-status">{state === "starting" ? "準備錄音…" : state === "recording" ? `錄音中 ${seconds} / 60 秒` : `${modelName} 辨識中…`}</span>}
    {state === "error" && <span role="alert" className="voice-input-error">{error}</span>}
    {state === "error" && recording.current && <button type="button" className="voice-input-button" onClick={() => void transcribe(recording.current!, ++generation.current)} aria-label="重試語音辨識" title="重試語音辨識"><RefreshCw size={16} /></button>}
    {(busy || state === "error") && <button type="button" className="voice-input-button" onClick={cancel} aria-label="取消語音輸入" title="取消語音輸入"><X size={16} /></button>}
  </div>
}
