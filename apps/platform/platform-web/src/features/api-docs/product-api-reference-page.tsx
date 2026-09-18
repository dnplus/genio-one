import SwaggerUI from "swagger-ui-react"
import "swagger-ui-react/swagger-ui.css"
import { useTranslation } from "react-i18next"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function ProductApiReferencePage() {
  const { t } = useTranslation()

  return (
    <div className="mx-auto w-full max-w-[1600px] p-6">
      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-2xl">{t("Product API reference")}</CardTitle>
          <CardDescription>
            {t("Interactive OpenAPI documentation for GenioOne V1.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <SwaggerUI
            url="/openapi.json"
            deepLinking
            displayRequestDuration
            docExpansion="list"
          />
        </CardContent>
      </Card>
    </div>
  )
}
