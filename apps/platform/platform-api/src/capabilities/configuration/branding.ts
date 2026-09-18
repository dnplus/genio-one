import { PlatformApiError } from "../errors"
import type {
  LoginBrandingSettings,
  PublicLoginBranding,
  TenantConfiguration,
} from "./contract"

const defaultLoginBranding: LoginBrandingSettings = {
  tagline: "企業 AI 存取治理控制平面",
  logo_url: "",
  primary_color: "#425fea",
  page_color: "#f7f8fa",
  custom_css: "",
}

const hexColor = /^#[0-9A-Fa-f]{6}$/

function isAllowedLoginLogoUrl(value: string): boolean {
  return value === "" ||
    (value.startsWith("/") && !value.startsWith("//")) ||
    value.startsWith("https://") ||
    value.startsWith("http://127.0.0.1") ||
    value.startsWith("http://localhost")
}

export function assertLoginBranding(value: LoginBrandingSettings | undefined): void {
  if (!value) return
  if (
    !isAllowedLoginLogoUrl(value.logo_url.trim()) ||
    !hexColor.test(value.primary_color) ||
    !hexColor.test(value.page_color) ||
    /<\/style\b/i.test(value.custom_css)
  ) {
    throw new PlatformApiError("TENANT_LOGIN_BRANDING_INVALID", 422)
  }
}

export function publicLoginBrandingFromConfiguration(
  configuration: TenantConfiguration | null | undefined,
): PublicLoginBranding {
  const settings = configuration?.login_branding
  const brandName = typeof configuration?.brand_name === "string" && configuration.brand_name.trim()
    ? configuration.brand_name.trim()
    : "GenioOne"
  const tagline = typeof settings?.tagline === "string" && settings.tagline.length <= 256
    ? settings.tagline
    : defaultLoginBranding.tagline
  const logoUrl = typeof settings?.logo_url === "string" &&
      settings.logo_url.length <= 2048 &&
      isAllowedLoginLogoUrl(settings.logo_url.trim())
    ? settings.logo_url.trim()
    : defaultLoginBranding.logo_url
  const primaryColor = typeof settings?.primary_color === "string" && hexColor.test(settings.primary_color)
    ? settings.primary_color
    : defaultLoginBranding.primary_color
  const pageColor = typeof settings?.page_color === "string" && hexColor.test(settings.page_color)
    ? settings.page_color
    : defaultLoginBranding.page_color
  const customCss = typeof settings?.custom_css === "string" &&
      settings.custom_css.length <= 16_384 &&
      !/<\/style\b/i.test(settings.custom_css)
    ? settings.custom_css
    : defaultLoginBranding.custom_css

  return {
    brand_name: brandName,
    tagline,
    logo_url: logoUrl,
    primary_color: primaryColor,
    page_color: pageColor,
    custom_css: customCss,
  }
}
