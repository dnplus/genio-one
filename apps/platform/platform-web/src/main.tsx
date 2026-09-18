import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "@/app"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SelfServiceApp } from "@/features/self-service/self-service-app"
import "@/i18n"
import "@/styles/globals.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname.startsWith("/self-service")
      ? <TooltipProvider><SelfServiceApp /></TooltipProvider>
      : <App />}
  </StrictMode>,
)
