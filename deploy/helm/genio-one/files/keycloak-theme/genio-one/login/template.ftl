<#import "field.ftl" as field>
<#import "footer.ftl" as loginFooter>

<#assign brandName = (realm.displayName!"GenioOne")?trim>
<#assign brandTagline = "">
<#assign brandLogoUrl = "">
<#assign brandPrimaryColor = "#425fea">
<#assign brandPageColor = "#f7f8fa">
<#assign brandCustomCss = "">
<#assign brandingEndpoint = "/v1/identity/login-branding">

<#if realm.attributes??>
    <#assign requestedBrandName = realm.attributes['genio.login.brandName']!"">
    <#assign requestedTagline = realm.attributes['genio.login.tagline']!"">
    <#assign requestedLogoUrl = realm.attributes['genio.login.logoUrl']!"">
    <#assign requestedPrimaryColor = realm.attributes['genio.login.primaryColor']!"">
    <#assign requestedPageColor = realm.attributes['genio.login.pageColor']!"">
    <#assign requestedCustomCss = realm.attributes['genio.login.customCss']!"">
    <#assign requestedBrandingEndpoint = realm.attributes['genio.login.brandingEndpoint']!"">
    <#if requestedBrandName?has_content>
        <#assign brandName = requestedBrandName?trim>
    </#if>
    <#if requestedTagline?has_content>
        <#assign brandTagline = requestedTagline?trim>
    </#if>
    <#if (requestedLogoUrl?starts_with("https://") || requestedLogoUrl?starts_with("http://127.0.0.1") || requestedLogoUrl?starts_with("http://localhost") || (requestedLogoUrl?starts_with("/") && !requestedLogoUrl?starts_with("//")))>
        <#assign brandLogoUrl = requestedLogoUrl?trim>
    </#if>
    <#if requestedPrimaryColor?matches("^[#][0-9A-Fa-f]{6}$")>
        <#assign brandPrimaryColor = requestedPrimaryColor?trim>
    </#if>
    <#if requestedPageColor?matches("^[#][0-9A-Fa-f]{6}$")>
        <#assign brandPageColor = requestedPageColor?trim>
    </#if>
    <#if requestedCustomCss?length <= 16384>
        <#assign brandCustomCss = requestedCustomCss>
    </#if>
    <#if (requestedBrandingEndpoint?starts_with("https://") || requestedBrandingEndpoint?starts_with("http://127.0.0.1") || requestedBrandingEndpoint?starts_with("http://localhost") || (requestedBrandingEndpoint?starts_with("/") && !requestedBrandingEndpoint?starts_with("//")))>
        <#assign brandingEndpoint = requestedBrandingEndpoint?trim>
    </#if>
</#if>

<#macro username>
  <#assign label>
    <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
  </#assign>
  <@field.group name="username" label=label>
    <div class="${properties.kcInputGroup}">
      <div class="${properties.kcInputGroupItemClass} ${properties.kcFill}">
        <span class="${properties.kcInputClass} ${properties.kcFormReadOnlyClass}">
          <input id="kc-attempted-username" value="${auth.attemptedUsername}" readonly>
        </span>
      </div>
      <div class="${properties.kcInputGroupItemClass}">
        <button id="reset-login" class="${properties.kcFormPasswordVisibilityButtonClass} kc-login-tooltip" type="button"
              aria-label="${msg('restartLoginTooltip')}" onclick="location.href='${url.loginRestartFlowUrl}'">
            <i class="fa-sync-alt fas" aria-hidden="true"></i>
            <span class="kc-tooltip-text">${msg("restartLoginTooltip")}</span>
        </button>
      </div>
    </div>
  </@field.group>
</#macro>

<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}" lang="${lang}"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="color-scheme" content="light${darkMode?then(' dark', '')}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title>${brandName} · ${msg("loginAccountTitle")}</title>
    <link rel="icon" href="${url.resourcesPath}/img/favicon.ico" />
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if brandCustomCss?has_content>
        <style id="genio-login-custom-css">${brandCustomCss?no_esc}</style>
    </#if>
    <script type="importmap">
        {
            "imports": {
                "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"
            }
        }
    </script>
    <#if darkMode>
      <script type="module" async blocking="render">
          <#outputformat "JavaScript">
          const DARK_MODE_CLASS = ${properties.kcDarkModeClass?c};
          const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
          updateDarkMode(mediaQuery.matches);
          mediaQuery.addEventListener("change", (event) => updateDarkMode(event.matches));
          function updateDarkMode(isEnabled) {
            const { classList } = document.documentElement;
            if (isEnabled) classList.add(DARK_MODE_CLASS);
            else classList.remove(DARK_MODE_CLASS);
          }
          </#outputformat>
      </script>
    </#if>
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="module" src="${url.resourcesPath}/js/passwordVisibility.js"></script>
    <script type="module">
        <#outputformat "JavaScript">
        import { startSessionPolling } from ${(url.resourcesPath + "/js/authChecker.js")?c};
        startSessionPolling(${url.ssoLoginInOtherTabsUrl?c});
        </#outputformat>
    </script>
    <script type="module">
        document.addEventListener("click", (event) => {
            const link = event.target.closest("a[data-once-link]");
            if (!link) return;
            if (link.getAttribute("aria-disabled") === "true") {
                event.preventDefault();
                return;
            }
            const { disabledClass } = link.dataset;
            if (disabledClass) link.classList.add(...disabledClass.trim().split(/\s+/));
            link.setAttribute("role", "link");
            link.setAttribute("aria-disabled", "true");
        });
    </script>
    <#if authenticationSession??>
        <script type="module">
            <#outputformat "JavaScript">
            import { checkAuthSession } from ${(url.resourcesPath + "/js/authChecker.js")?c};
            checkAuthSession(${authenticationSession.authSessionIdHash?c});
            </#outputformat>
        </script>
    </#if>
    <script>
      const isFirefox = true;
    </script>
</head>
<body id="keycloak-bg" class="${properties.kcBodyClass!}" data-page-id="login-${pageId}" style="--genio-brand-primary: ${brandPrimaryColor}; --genio-brand-page: ${brandPageColor};">
<div class="${properties.kcLogin!}">
  <div class="${properties.kcLoginContainer!}">
    <header id="kc-header" class="pf-v5-c-login__header">
      <div id="kc-header-wrapper" class="genio-brand">
        <img class="genio-brand__default-logo" data-genio-brand-default-logo src="${url.resourcesPath}/img/genioone-horizontal-color-light.svg" alt="${brandName}"<#if brandLogoUrl?has_content || brandName != "GenioOne"> hidden</#if> />
        <img class="genio-brand__default-icon" data-genio-brand-default-icon src="${url.resourcesPath}/img/genioone-icon-color-light.svg" alt="" aria-hidden="true"<#if brandLogoUrl?has_content || brandName == "GenioOne"> hidden</#if> />
        <#if brandLogoUrl?has_content>
          <img class="genio-brand__logo" data-genio-brand-logo src="${brandLogoUrl}" alt="${brandName}" />
        </#if>
        <span class="genio-brand__name" data-genio-brand-name<#if !brandLogoUrl?has_content && brandName == "GenioOne"> hidden</#if>>${brandName}</span>
      </div>
      <p class="genio-brand__tagline" data-genio-brand-tagline<#if !brandTagline?has_content> hidden</#if>>${brandTagline}</p>
    </header>
    <main class="${properties.kcLoginMain!}">
      <div class="${properties.kcLoginMainHeader!}">
        <h1 class="${properties.kcLoginMainTitle!}" id="kc-page-title"><#nested "header"></h1>
        <#if realm.internationalizationEnabled && locale.supported?size gt 1>
        <div class="${properties.kcLoginMainHeaderUtilities!}">
          <div class="${properties.kcInputClass!}">
            <select aria-label="${msg("languages")}" id="login-select-toggle" onchange="if (this.value) window.location.href=this.value">
              <#list locale.supported?sort_by("label") as l>
                <option value="${l.url}" ${(l.languageTag == locale.currentLanguageTag)?then('selected','')}>${l.label}</option>
              </#list>
            </select>
            <span class="${properties.kcFormControlUtilClass}">
              <span class="${properties.kcFormControlToggleIcon!}">
                <svg class="pf-v5-svg" viewBox="0 0 320 512" fill="currentColor" aria-hidden="true" role="img" width="1em" height="1em">
                  <path d="M31.3 192h257.3c17.8 0 26.7 21.5 14.1 34.1L174.1 354.8c-7.8 7.8-20.5 7.8-28.3 0L17.2 226.1C4.6 213.5 13.5 192 31.3 192z"></path>
                </svg>
              </span>
            </span>
          </div>
        </div>
        </#if>
      </div>
      <div class="${properties.kcLoginMainBody!}">
        <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
            <#if displayRequiredFields>
                <div class="${properties.kcContentWrapperClass!}">
                    <div class="${properties.kcLabelWrapperClass!} subtitle">
                        <span class="${properties.kcInputHelperTextItemTextClass!}"><span class="${properties.kcInputRequiredClass!}">*</span> ${msg("requiredFields")}</span>
                    </div>
                </div>
            </#if>
        <#else>
            <#if displayRequiredFields>
                <div class="${properties.kcContentWrapperClass!}">
                    <div class="${properties.kcLabelWrapperClass!} subtitle">
                        <span class="${properties.kcInputHelperTextItemTextClass!}"><span class="${properties.kcInputRequiredClass!}">*</span> ${msg("requiredFields")}</span>
                    </div>
                    <div class="${properties.kcFormClass} ${properties.kcContentWrapperClass}">
                        <#nested "show-username">
                        <@username />
                    </div>
                </div>
            <#else>
                <div class="${properties.kcFormClass} ${properties.kcContentWrapperClass}">
                  <#nested "show-username">
                  <@username />
                </div>
            </#if>
        </#if>
        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <div class="${properties.kcAlertClass!} pf-m-${(message.type = 'error')?then('danger', message.type)}">
                <div class="${properties.kcAlertIconClass!}">
                    <#if message.type = 'success'><span class="${properties.kcFeedbackSuccessIcon!}"></span></#if>
                    <#if message.type = 'warning'><span class="${properties.kcFeedbackWarningIcon!}"></span></#if>
                    <#if message.type = 'error'><span class="${properties.kcFeedbackErrorIcon!}"></span></#if>
                    <#if message.type = 'info'><span class="${properties.kcFeedbackInfoIcon!}"></span></#if>
                </div>
                <span class="${properties.kcAlertTitleClass!} kc-feedback-text">${message.summary}</span>
            </div>
        </#if>
        <#nested "form">
        <#if auth?has_content && auth.showTryAnotherWayLink()>
          <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" novalidate="novalidate">
              <input type="hidden" name="tryAnotherWay" value="on"/>
              <a id="try-another-way" href="javascript:document.forms['kc-select-try-another-way-form'].requestSubmit()" class="${properties.kcButtonSecondaryClass} ${properties.kcButtonBlockClass} ${properties.kcMarginTopClass}">${msg("doTryAnotherWay")}</a>
          </form>
        </#if>
        <div class="${properties.kcLoginMainFooter!}">
            <#nested "socialProviders">
            <#if displayInfo>
                <div id="kc-info" class="${properties.kcLoginMainFooterBand!} ${properties.kcFormClass}">
                    <div id="kc-info-wrapper" class="${properties.kcLoginMainFooterBandItem!}"><#nested "info"></div>
                </div>
            </#if>
        </div>
      </div>
      <div class="${properties.kcLoginMainFooter!}">
          <@loginFooter.content/>
      </div>
    </main>
  </div>
</div>
<script type="module">
    <#outputformat "JavaScript">
    const loginBrandingEndpoint = ${brandingEndpoint?c};
    const loginBrandingFallbackName = ${brandName?c};
    const loginBrandingFallbackTagline = ${brandTagline?c};
    const loginBrandingColor = (value, fallback) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    const loginBrandingLogoUrl = (value) => {
        if (typeof value !== "string") return "";
        const candidate = value.trim();
        if (candidate === "" || candidate.startsWith("https://") || candidate.startsWith("http://127.0.0.1") || candidate.startsWith("http://localhost")) return candidate;
        return candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "";
    };
    const applyLoginBranding = (branding) => {
        if (!branding || typeof branding !== "object") return;
        const name = typeof branding.brand_name === "string" && branding.brand_name.trim() ? branding.brand_name.trim() : loginBrandingFallbackName;
        const tagline = typeof branding.tagline === "string" ? branding.tagline : loginBrandingFallbackTagline;
        const logoUrl = loginBrandingLogoUrl(branding.logo_url);
        const primaryColor = loginBrandingColor(branding.primary_color, "#425fea");
        const pageColor = loginBrandingColor(branding.page_color, "#f7f8fa");
        const nameNode = document.querySelector("[data-genio-brand-name]");
        if (nameNode) nameNode.textContent = name;
        const taglineNode = document.querySelector("[data-genio-brand-tagline]");
        if (taglineNode) {
            taglineNode.textContent = tagline;
            taglineNode.hidden = !tagline;
        }
        document.title = name + " · " + (document.title.split(" · ").slice(1).join(" · ") || document.title);
        document.documentElement.style.setProperty("--genio-brand-primary", primaryColor);
        document.documentElement.style.setProperty("--genio-brand-page", pageColor);
        document.body.style.setProperty("--genio-brand-primary", primaryColor);
        document.body.style.setProperty("--genio-brand-page", pageColor);
        const header = document.querySelector("#kc-header-wrapper");
        if (header) {
            const defaultLogo = header.querySelector("[data-genio-brand-default-logo]");
            const defaultIcon = header.querySelector("[data-genio-brand-default-icon]");
            let logo = header.querySelector("[data-genio-brand-logo]");
            if (logoUrl) {
                if (!logo) {
                    logo = document.createElement("img");
                    logo.className = "genio-brand__logo";
                    logo.dataset.genioBrandLogo = "true";
                    header.insertBefore(logo, header.querySelector("[data-genio-brand-name]"));
                }
                logo.src = logoUrl;
                logo.alt = name;
                logo.hidden = false;
                if (defaultLogo) defaultLogo.hidden = true;
                if (defaultIcon) defaultIcon.hidden = true;
                if (nameNode) nameNode.hidden = false;
            } else {
                const useDefaultWordmark = name === "GenioOne";
                if (defaultLogo) defaultLogo.hidden = !useDefaultWordmark;
                if (defaultIcon) defaultIcon.hidden = useDefaultWordmark;
                if (logo) logo.hidden = true;
                if (nameNode) nameNode.hidden = useDefaultWordmark;
            }
        }
        const customCss = typeof branding.custom_css === "string" ? branding.custom_css : "";
        const customStyle = document.getElementById("genio-login-custom-css") || document.createElement("style");
        customStyle.id = "genio-login-custom-css";
        customStyle.textContent = customCss;
        if (!customStyle.isConnected) document.head.append(customStyle);
    };
    fetch(loginBrandingEndpoint, { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then(applyLoginBranding)
        .catch(() => undefined);
    </#outputformat>
</script>
</body>
</html>
</#macro>
