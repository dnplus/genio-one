import type { ThreadItem } from "../../../server/generated/v2/ThreadItem"

export function MessageMedia({ item, images = [] }: { item?: ThreadItem; images?: string[] }) {
  const parts = item?.type === "userMessage" ? item.content : images.map((url) => ({ type: "image" as const, url }))
  return <>{parts.filter((part) => ["image", "audio", "localImage", "localAudio"].includes(part.type)).map((part, index) => {
    if (part.type === "image") {
      if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(part.url)) return <img key={index} className="chat-image" src={part.url} alt={`附加圖片 ${index + 1}`} loading="lazy" />
      if (/^https?:\/\//i.test(part.url)) return <a key={index} href={part.url} target="_blank" rel="noreferrer">開啟附加圖片 {index + 1}</a>
      return <p key={index}>圖片來源已無法使用</p>
    }
    if (part.type === "audio") {
      if (/^(https?:\/\/|data:audio\/)/i.test(part.url)) return <audio key={index} controls preload="none" src={part.url} aria-label={`附加音訊 ${index + 1}`} />
      return <p key={index}>音訊來源已無法使用</p>
    }
    if (part.type === "localImage" || part.type === "localAudio") return <p key={index}>原工作區附件：{part.path}（需原執行環境才能讀取）</p>
    return null
  })}</>
}
