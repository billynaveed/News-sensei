import { LayoutDashboard, Settings, Activity, TrendingUp, BookmarkCheck, Bug, Building2 } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuBadge,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import type { Lead } from "@shared/schema";

const menuItems = [
  {
    title: "Dashboard",
    url: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
  {
    title: "Scan Logs",
    url: "/logs",
    icon: Activity,
  },
  {
    title: "Debug",
    url: "/debug",
    icon: Bug,
  },
  {
    title: "IPO Filings",
    url: "/ipo-filings",
    icon: Building2,
  },
];

export function AppSidebar() {
  const [location] = useLocation();
  const searchString = useSearch();
  const { setOpenMobile, isMobile } = useSidebar();

  const { data: savedLeads } = useQuery<any[]>({
    queryKey: ["/api/saved-leads"],
  });

  const savedCount = savedLeads?.length ?? 0;

  // Close sidebar on mobile when navigation item is clicked
  const handleNavClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary text-primary-foreground">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-base tracking-tight">Lead Intel</span>
            <span className="text-xs text-muted-foreground">Private Banking</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={location === item.url}
                    data-testid={`nav-${item.title.toLowerCase().replace(" ", "-")}`}
                  >
                    <Link href={item.url} onClick={handleNavClick}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Quick Access</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === "/saved-leads"}
                  data-testid="nav-saved-leads"
                >
                  <Link href="/saved-leads" onClick={handleNavClick}>
                    <BookmarkCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span>Saved Leads</span>
                  </Link>
                </SidebarMenuButton>
                {savedCount > 0 && (
                  <SidebarMenuBadge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    {savedCount}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 border-t border-sidebar-border">
        <div className="text-xs text-muted-foreground">
          Southeast Asia Coverage
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
