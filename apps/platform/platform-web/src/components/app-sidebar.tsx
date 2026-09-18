import { UserPermissionPreviewDialog } from "@/features/policy/user-permission-preview"
import {
  BookOpenIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  FlaskConicalIcon,
  SearchIcon,
  UserCogIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import genioOneLightLogo from "../../../../../packages/brand/assets/logo-02.svg"
import genioOneDarkLogo from "../../../../../packages/brand/assets/logo-03.svg"

import { ManagementSearchDialog } from "@/components/management-search-dialog"
import { managementNavigation, type PageId } from "@/components/management-navigation"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import type { IdentitySession, OverviewSnapshot } from "@/domain/contracts"
import type { AccessTier } from "@/features/overview/platform-topology"

export type { PageId } from "@/components/management-navigation"

interface AppSidebarProps {
  activePage: PageId
  identity: IdentitySession
  data: OverviewSnapshot | null
  mockMode: boolean
  demoTier: AccessTier
  demoGuideVisible: boolean
  search: string
  onDemoGuideVisibleChange: (visible: boolean) => void
  onDemoTierChange: (tier: AccessTier) => void
  onNavigate: (page: PageId, options?: { filter?: string; focusedResourceId?: string }) => void
  onSearchChange: (value: string) => void
  onSignOut: () => void
}

function ProductMark() {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 items-center gap-3 px-1 py-1">
      <img alt="GenioOne" className="size-12 shrink-0 object-contain group-data-[collapsible=icon]:size-8 dark:hidden" src={genioOneLightLogo} />
      <img alt="GenioOne" className="hidden size-12 shrink-0 object-contain group-data-[collapsible=icon]:size-8 dark:block" src={genioOneDarkLogo} />
      <div className="min-w-0 group-data-[collapsible=icon]:hidden">
        <div className="truncate text-xs font-semibold tracking-[0.04em] text-foreground uppercase">{t("Control Plane")}</div>
      </div>
    </div>
  )
}

export function AppSidebar({
  activePage,
  identity,
  data,
  mockMode,
  demoTier,
  demoGuideVisible,
  search,
  onDemoGuideVisibleChange,
  onDemoTierChange,
  onNavigate,
  onSearchChange,
  onSignOut,
}: AppSidebarProps) {
  const { t } = useTranslation()
  const { setOpenMobile } = useSidebar()
  const accountName = data?.identity?.subjects.find((subject) => subject.subject_id === identity.subject_id)?.profile.display_name ?? identity.subject_id
  const [permissionPreviewOpen, setPermissionPreviewOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [globalQuery, setGlobalQuery] = useState(search)

  function openGlobalSearch() {
    setGlobalQuery(search)
    setOpenMobile(false)
    setSearchOpen(true)
  }

  function handleNavigate(page: PageId, options?: { filter?: string; focusedResourceId?: string }) {
    setSearchOpen(false)
    setOpenMobile(false)
    onNavigate(page, options)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      setGlobalQuery(search)
      setSearchOpen(true)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [search])

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-b p-3">
          <div className="flex min-w-0 items-center">
            <ProductMark />
            <SidebarTrigger className="ml-auto shrink-0 group-data-[collapsible=icon]:hidden" />
          </div>
          <SidebarTrigger className="hidden self-center group-data-[collapsible=icon]:flex" />
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                data-testid="global-search-trigger"
                onClick={openGlobalSearch}
                tooltip={t("Global search")}
                variant="outline"
              >
                <SearchIcon />
                <span>{search || t("Global search")}</span>
                <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">
                  {t("Command K")}
                </Kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent className="py-3">
          {managementNavigation.map((group, groupIndex) => (
            <SidebarGroup key={group.label} className="py-1 group-data-[collapsible=icon]:px-3">
              {groupIndex > 0 ? <SidebarGroupLabel>{t(group.label)}</SidebarGroupLabel> : null}
              <SidebarGroupContent>
                <SidebarMenu className="gap-1">
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        aria-current={activePage === item.id ? "page" : undefined}
                        isActive={activePage === item.id}
                        tooltip={t(item.label)}
                        onClick={() => handleNavigate(item.id)}
                      >
                        <item.icon />
                        <span>{t(item.label)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter className="border-t p-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    className="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
                    data-testid="account-menu-trigger"
                    size="lg"
                    tooltip={accountName}
                  >
                    <Avatar size="sm">
                      <AvatarFallback>{identity.role === "TENANT_ADMINISTRATOR" ? "TA" : identity.role === "ORGANIZATION_ADMINISTRATOR" ? "OA" : "U"}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden">
                      <div className="truncate font-medium">{accountName}</div>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <div className="truncate text-xs text-muted-foreground">{identity.tenant_id}</div>
                        {mockMode ? <Badge className="shrink-0" variant="secondary">{t("Demo {{tier}}", { tier: demoTier })}</Badge> : null}
                      </div>
                    </div>
                    <ChevronDownIcon className="group-data-[collapsible=icon]:hidden" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="right" sideOffset={8} className="w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        {accountName}
                        {mockMode ? <Badge variant="secondary">{t("Demo {{tier}}", { tier: demoTier })}</Badge> : null}
                      </span>
                      <span className="font-normal text-muted-foreground">{identity.tenant_id}</span>
                    </DropdownMenuLabel>
                  </DropdownMenuGroup>
                  {mockMode ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuLabel className="flex items-center gap-2">
                          <FlaskConicalIcon className="size-4" />
                          {t("Demo experience")}
                        </DropdownMenuLabel>
                        <DropdownMenuLabel>{t("Demo tier")}</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={demoTier} onValueChange={(value) => onDemoTierChange(value as AccessTier)}>
                          <DropdownMenuRadioItem value="T1">{t("T1")}</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="T2">{t("T2")}</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                        <DropdownMenuCheckboxItem
                          checked={demoGuideVisible}
                          onCheckedChange={(checked) => onDemoGuideVisibleChange(checked === true)}
                        >
                          {t("Show page guide")}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuGroup>
                    </>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    {identity.role === "TENANT_ADMINISTRATOR" && !mockMode ? <DropdownMenuItem disabled={!data} onClick={() => { setOpenMobile(false); setPermissionPreviewOpen(true) }}>{t("View as user permissions")}</DropdownMenuItem> : null}
                    <DropdownMenuItem onClick={() => handleNavigate("personal-settings")}>
                      <UserCogIcon />
                      {t("Personal settings")}
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <a href="/self-service">{t("Open Self-service")}</a>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => handleNavigate("product-docs")}>
                      <BookOpenIcon />
                      {t("Product documentation")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleNavigate("api-docs")}>
                      <CircleHelpIcon />
                      {t("Product API reference")}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled>{t("GenioOne V1")}</DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={mockMode} onClick={onSignOut}>
                      {t("Sign out")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      {permissionPreviewOpen && data ? <UserPermissionPreviewDialog tenantId={identity.tenant_id} data={data} onClose={() => setPermissionPreviewOpen(false)} /> : null}
      <ManagementSearchDialog
        currentSearch={search}
        data={data}
        navigation={managementNavigation}
        onNavigate={handleNavigate}
        onOpenChange={setSearchOpen}
        onQueryChange={setGlobalQuery}
        onSearchCurrentView={onSearchChange}
        open={searchOpen}
        query={globalQuery}
      />
    </>
  )
}
